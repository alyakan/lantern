//! A WireGuard endpoint the phone's WireGuard app connects to, so every app's traffic comes through Lantern whether or
//! not it uses the system proxy (a Flutter app's Dart client doesn't).
//!
//! The tunnel's packets are run through a TCP/IP stack in userspace (smoltcp) that accepts a connection to any address:
//! each one is handed to the capture as a stream, read as TLS on 443 and HTTP on 80, and passed through unread to where
//! the phone was going on any other port. DNS is sent on for the phone; other UDP (QUIC) is dropped, so apps fall back
//! to TCP. IPv6 is dropped too: apps fall back to IPv4.

use super::intercept::{self, Engine, Origin};
use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::time::Instant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpListenEndpoint, IpProtocol, Ipv4Address, Ipv4Packet, Ipv4Repr, TcpPacket, UdpPacket, UdpRepr};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, Notify};

/// The tunnel's addresses: the Mac's end, and the phone's.
pub const SERVER_IP: Ipv4Address = Ipv4Address::new(10, 233, 0, 1);
pub const PHONE_IP: Ipv4Address = Ipv4Address::new(10, 233, 0, 2);
/// Small enough for any network the phone is on, with WireGuard's own headers on top.
pub const MTU: usize = 1280;
/// Where DNS the phone sends to the Mac's end goes.
const DNS_UPSTREAM: SocketAddrV4 = SocketAddrV4::new(Ipv4Address::new(1, 1, 1, 1), 53);
/// How much of a connection is held on each side before the other has to wait.
const CHANNEL_CHUNKS: usize = 16;
const CHUNK: usize = 16 << 10;

/// The two key pairs: the Mac's end and the phone's (Lantern makes both, and hands the phone its config).
#[derive(Clone)]
pub struct Keys {
    pub server: [u8; 32],
    pub phone: [u8; 32],
}

impl Keys {
    pub fn generate() -> Self {
        let mut server = [0u8; 32];
        let mut phone = [0u8; 32];
        getrandom::fill(&mut server).expect("the system's random numbers");
        getrandom::fill(&mut phone).expect("the system's random numbers");
        Self { server, phone }
    }

    pub fn public(secret: &[u8; 32]) -> [u8; 32] {
        PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
    }
}

/// Which ports are read, and how.
#[derive(Clone)]
pub struct Ports {
    pub http: Vec<u16>,
    pub tls: Vec<u16>,
}

impl Default for Ports {
    fn default() -> Self {
        Self { http: vec![80], tls: vec![443] }
    }
}

/// The phone's WireGuard config, for the Mac at `endpoint`.
pub fn phone_config(keys: &Keys, endpoint: &str) -> String {
    use base64::Engine as _;
    let b64 = |k: &[u8; 32]| base64::engine::general_purpose::STANDARD.encode(k);
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = {PHONE_IP}/32\nDNS = {}\nMTU = {MTU}\n\n[Peer]\nPublicKey = {}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = {endpoint}\nPersistentKeepalive = 25\n",
        b64(&keys.phone),
        DNS_UPSTREAM.ip(),
        b64(&Keys::public(&keys.server)),
    )
}

/// Runs the endpoint on `udp` until the task is dropped.
pub async fn run(engine: Arc<Engine>, udp: UdpSocket, keys: Keys, ports: Ports) {
    let mut tunn = Tunn::new(StaticSecret::from(keys.server), PublicKey::from(&StaticSecret::from(keys.phone)), None, None, 0, None);
    let wake = Arc::new(Notify::new());
    let (to_phone, mut packets) = mpsc::channel::<Vec<u8>>(256);
    let mut net = Net::new(engine, ports, wake.clone(), to_phone);
    let mut peer: Option<SocketAddr> = None;
    let mut buf = vec![0u8; 65536];
    let mut out = vec![0u8; 65536 + 148];
    let mut timers = tokio::time::interval(Duration::from_millis(250));
    loop {
        let delay = net.delay().min(Duration::from_millis(250));
        tokio::select! {
            got = udp.recv_from(&mut buf) => {
                let Ok((n, from)) = got else { continue };
                let mut datagram = &buf[..n];
                loop {
                    match tunn.decapsulate(Some(from.ip()), datagram, &mut out) {
                        TunnResult::WriteToNetwork(p) => {
                            peer = Some(from);
                            let _ = udp.send_to(p, from).await;
                            // Again with nothing, until it has sent what it queued.
                            datagram = &[];
                        }
                        TunnResult::WriteToTunnelV4(p, _) => {
                            peer = Some(from);
                            net.inbound(p);
                            break;
                        }
                        _ => break,
                    }
                }
            }
            _ = timers.tick() => {
                if let (TunnResult::WriteToNetwork(p), Some(to)) = (tunn.update_timers(&mut out), peer) {
                    let _ = udp.send_to(p, to).await;
                }
            }
            Some(p) = packets.recv() => net.device.tx.push_back(p),
            _ = wake.notified() => {}
            _ = tokio::time::sleep(delay) => {}
        }
        net.pump();
        while let Some(p) = net.device.tx.pop_front() {
            let Some(to) = peer else { continue };
            if let TunnResult::WriteToNetwork(w) = tunn.encapsulate(&p, &mut out) {
                let _ = udp.send_to(w, to).await;
            }
        }
    }
}

/// The packets going each way between the tunnel and the TCP/IP stack.
#[derive(Default)]
struct Queue {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut p = vec![0u8; len];
        let r = f(&mut p);
        self.0.push_back(p);
        r
    }
}

impl Device for Queue {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn receive(&mut self, _: Instant) -> Option<(Rx, Tx<'_>)> {
        let p = self.rx.pop_front()?;
        Some((Rx(p), Tx(&mut self.tx)))
    }

    fn transmit(&mut self, _: Instant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = MTU;
        caps
    }
}

/// One of the phone's connections, between its socket and the task reading it.
struct Conn {
    key: (SocketAddrV4, SocketAddrV4),
    /// What the phone sent, to the task (gone once the phone has finished sending).
    up: Option<mpsc::Sender<Vec<u8>>>,
    /// What the task has for the phone.
    down: mpsc::Receiver<Vec<u8>>,
    /// Taken from `down`, not all sent yet.
    pending: Vec<u8>,
    /// The task has finished: close once `pending` is sent.
    finished: bool,
}

struct Net {
    iface: Interface,
    device: Queue,
    sockets: SocketSet<'static>,
    conns: HashMap<SocketHandle, Conn>,
    open: HashSet<(SocketAddrV4, SocketAddrV4)>,
    engine: Arc<Engine>,
    ports: Ports,
    wake: Arc<Notify>,
    /// Packets made outside the stack (DNS replies), for the phone.
    to_phone: mpsc::Sender<Vec<u8>>,
}

impl Net {
    fn new(engine: Arc<Engine>, ports: Ports, wake: Arc<Notify>, to_phone: mpsc::Sender<Vec<u8>>) -> Self {
        let mut device = Queue::default();
        let mut iface = Interface::new(Config::new(HardwareAddress::Ip), &mut device, Instant::now());
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(IpAddress::Ipv4(SERVER_IP), 24));
        });
        // With a default route through its own address, the stack takes packets for any address as its own.
        let _ = iface.routes_mut().add_default_ipv4_route(SERVER_IP);
        iface.set_any_ip(true);
        Self { iface, device, sockets: SocketSet::new(Vec::new()), conns: HashMap::new(), open: HashSet::new(), engine, ports, wake, to_phone }
    }

    fn delay(&mut self) -> Duration {
        self.iface.poll_delay(Instant::now(), &self.sockets).map(|d| Duration::from_micros(d.total_micros())).unwrap_or(Duration::MAX)
    }

    /// A packet from the phone.
    fn inbound(&mut self, packet: &[u8]) {
        let Ok(ip) = Ipv4Packet::new_checked(packet) else { return };
        let (src, dst) = (ip.src_addr(), ip.dst_addr());
        match ip.next_header() {
            IpProtocol::Udp => {
                let Ok(udp) = UdpPacket::new_checked(ip.payload()) else { return };
                if udp.dst_port() == 53 {
                    let from = SocketAddrV4::new(src, udp.src_port());
                    let to = SocketAddrV4::new(dst, 53);
                    tokio::spawn(dns(from, to, udp.payload().to_vec(), self.to_phone.clone(), self.wake.clone()));
                }
            }
            IpProtocol::Tcp => {
                let Ok(tcp) = TcpPacket::new_checked(ip.payload()) else { return };
                let key = (SocketAddrV4::new(src, tcp.src_port()), SocketAddrV4::new(dst, tcp.dst_port()));
                if tcp.syn() && !tcp.ack() && !self.open.contains(&key) {
                    self.accept(key);
                }
                self.device.rx.push_back(packet.to_vec());
                // Now, so a socket made for this connection takes this SYN and not the next one's.
                self.pump();
            }
            _ => {}
        }
    }

    /// A socket listening for the connection the phone is opening, and a task to read it.
    fn accept(&mut self, key: (SocketAddrV4, SocketAddrV4)) {
        let mut socket = tcp::Socket::new(tcp::SocketBuffer::new(vec![0; 64 << 10]), tcp::SocketBuffer::new(vec![0; 256 << 10]));
        if socket.listen(IpListenEndpoint { addr: Some(IpAddress::Ipv4(*key.1.ip())), port: key.1.port() }).is_err() {
            return;
        }
        let handle = self.sockets.add(socket);
        let (up_tx, up_rx) = mpsc::channel(CHANNEL_CHUNKS);
        let (down_tx, down_rx) = mpsc::channel(CHANNEL_CHUNKS);
        self.conns.insert(handle, Conn { key, up: Some(up_tx), down: down_rx, pending: Vec::new(), finished: false });
        self.open.insert(key);
        tokio::spawn(connection(self.engine.clone(), self.ports.clone(), key.1, up_rx, down_tx, self.wake.clone()));
    }

    /// Runs the stack, and moves what's waiting between each socket and its task.
    fn pump(&mut self) {
        self.iface.poll(Instant::now(), &mut self.device, &mut self.sockets);
        let mut closed = Vec::new();
        for (&handle, conn) in self.conns.iter_mut() {
            let s = self.sockets.get_mut::<tcp::Socket>(handle);
            if let Some(up) = &conn.up {
                while s.can_recv() {
                    let Ok(permit) = up.try_reserve() else { break };
                    if let Ok(data) = s.recv(|b| {
                        let n = b.len().min(CHUNK);
                        (n, b[..n].to_vec())
                    }) {
                        permit.send(data);
                    }
                }
                let opening = matches!(s.state(), tcp::State::Listen | tcp::State::SynReceived | tcp::State::SynSent);
                if !opening && !s.may_recv() && s.recv_queue() == 0 {
                    conn.up = None;
                }
            }
            loop {
                if conn.pending.is_empty() {
                    match conn.down.try_recv() {
                        Ok(d) => conn.pending = d,
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            conn.finished = true;
                            break;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                    }
                }
                if !s.can_send() {
                    break;
                }
                let n = s.send_slice(&conn.pending).unwrap_or(0);
                conn.pending.drain(..n);
                if n == 0 {
                    break;
                }
            }
            if conn.finished && conn.pending.is_empty() && s.state() != tcp::State::Listen {
                s.close();
            }
            if matches!(s.state(), tcp::State::Closed | tcp::State::TimeWait) || (conn.finished && s.state() == tcp::State::Listen) {
                closed.push(handle);
            }
        }
        for handle in closed {
            if let Some(conn) = self.conns.remove(&handle) {
                self.open.remove(&conn.key);
            }
            self.sockets.remove(handle);
        }
        self.iface.poll(Instant::now(), &mut self.device, &mut self.sockets);
    }
}

/// Reads one of the phone's connections (to `dst`): its bytes come on `up`, and what goes back to it on `down`.
async fn connection(engine: Arc<Engine>, ports: Ports, dst: SocketAddrV4, mut up: mpsc::Receiver<Vec<u8>>, down: mpsc::Sender<Vec<u8>>, wake: Arc<Notify>) {
    let (ours, theirs) = tokio::io::duplex(64 << 10);
    let (mut read, mut write) = tokio::io::split(ours);
    let into = wake.clone();
    tokio::spawn(async move {
        while let Some(d) = up.recv().await {
            // Room on `up` again: the stack may have more of the phone's bytes to hand over.
            into.notify_one();
            if write.write_all(&d).await.is_err() {
                break;
            }
        }
        let _ = write.shutdown().await;
    });
    tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if down.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                    wake.notify_one();
                }
            }
        }
        drop(down);
        wake.notify_one();
    });
    let port = dst.port();
    let ip = dst.ip().to_string();
    if *dst.ip() == SERVER_IP && port == 80 {
        // The Mac's own end of the tunnel: the page that hands out Lantern's root.
        let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
            let res = super::proxy::setup(req.uri().path(), &engine.ca);
            async move { Ok::<_, std::io::Error>(res) }
        });
        let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(theirs), service).await;
    } else if ports.tls.contains(&port) {
        intercept::intercept(engine, theirs, ip, port, dst.to_string()).await;
    } else if ports.http.contains(&port) {
        let authority = if port == 80 { ip } else { dst.to_string() };
        intercept::serve(engine, theirs, Some(Origin { scheme: "http", authority })).await;
    } else {
        intercept::pass(theirs, &dst.to_string()).await;
    }
}

/// Sends one of the phone's DNS queries on (to where it was going, or to DNS_UPSTREAM if that's the Mac's end), and
/// hands the reply back to it as a packet.
async fn dns(from: SocketAddrV4, to: SocketAddrV4, query: Vec<u8>, back: mpsc::Sender<Vec<u8>>, wake: Arc<Notify>) {
    let server = if *to.ip() == SERVER_IP { DNS_UPSTREAM } else { to };
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await else { return };
    if socket.send_to(&query, server).await.is_err() {
        return;
    }
    let mut buf = vec![0u8; 4096];
    let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), socket.recv(&mut buf)).await else { return };
    if back.send(udp_packet(to, from, &buf[..n])).await.is_ok() {
        wake.notify_one();
    }
}

/// An IPv4 UDP packet.
fn udp_packet(src: SocketAddrV4, dst: SocketAddrV4, payload: &[u8]) -> Vec<u8> {
    let caps = ChecksumCapabilities::default();
    let udp = UdpRepr { src_port: src.port(), dst_port: dst.port() };
    let ip = Ipv4Repr { src_addr: *src.ip(), dst_addr: *dst.ip(), next_header: IpProtocol::Udp, payload_len: udp.header_len() + payload.len(), hop_limit: 64 };
    let mut buf = vec![0u8; ip.buffer_len() + ip.payload_len];
    let mut packet = Ipv4Packet::new_unchecked(&mut buf[..]);
    ip.emit(&mut packet, &caps);
    let mut datagram = UdpPacket::new_unchecked(packet.payload_mut());
    udp.emit(&mut datagram, &IpAddress::Ipv4(*src.ip()), &IpAddress::Ipv4(*dst.ip()), payload.len(), |b| b.copy_from_slice(payload), &caps);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::ca::Authority;
    use crate::capture::recorder::Recorder;
    use crate::network::Source;
    use std::net::Ipv4Addr;

    /// The phone's side: a WireGuard client and its own TCP/IP stack, talking to the endpoint over loopback.
    struct Phone {
        tunn: Tunn,
        udp: UdpSocket,
        server: SocketAddr,
        iface: Interface,
        device: Queue,
        sockets: SocketSet<'static>,
    }

    impl Phone {
        async fn new(keys: &Keys, server: SocketAddr) -> Self {
            let tunn = Tunn::new(StaticSecret::from(keys.phone), PublicKey::from(&StaticSecret::from(keys.server)), None, None, 1, None);
            let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let mut device = Queue::default();
            let mut iface = Interface::new(Config::new(HardwareAddress::Ip), &mut device, Instant::now());
            iface.update_ip_addrs(|a| {
                let _ = a.push(IpCidr::new(IpAddress::Ipv4(PHONE_IP), 32));
            });
            let _ = iface.routes_mut().add_default_ipv4_route(PHONE_IP);
            Self { tunn, udp, server, iface, device, sockets: SocketSet::new(Vec::new()) }
        }

        /// Moves packets both ways for a moment.
        async fn step(&mut self) {
            let mut out = vec![0u8; 65536 + 148];
            self.iface.poll(Instant::now(), &mut self.device, &mut self.sockets);
            while let Some(p) = self.device.tx.pop_front() {
                if let TunnResult::WriteToNetwork(w) = self.tunn.encapsulate(&p, &mut out) {
                    self.udp.send_to(w, self.server).await.unwrap();
                }
            }
            if let TunnResult::WriteToNetwork(w) = self.tunn.update_timers(&mut out) {
                self.udp.send_to(w, self.server).await.unwrap();
            }
            let mut buf = vec![0u8; 65536];
            while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(5), self.udp.recv(&mut buf)).await {
                let mut datagram = &buf[..n];
                loop {
                    match self.tunn.decapsulate(None, datagram, &mut out) {
                        TunnResult::WriteToNetwork(w) => {
                            self.udp.send_to(w, self.server).await.unwrap();
                            datagram = &[];
                        }
                        TunnResult::WriteToTunnelV4(p, _) => {
                            self.device.rx.push_back(p.to_vec());
                            break;
                        }
                        _ => break,
                    }
                }
            }
            self.iface.poll(Instant::now(), &mut self.device, &mut self.sockets);
        }

        /// Opens a TCP connection to `to`, sends `request` once it's open, and reads until the far side closes.
        async fn exchange(&mut self, to: SocketAddrV4, request: &[u8]) -> Vec<u8> {
            let mut socket = tcp::Socket::new(tcp::SocketBuffer::new(vec![0; 64 << 10]), tcp::SocketBuffer::new(vec![0; 64 << 10]));
            socket.connect(self.iface.context(), (IpAddress::Ipv4(*to.ip()), to.port()), 49152).unwrap();
            let h = self.sockets.add(socket);
            let (mut sent, mut got) = (false, Vec::new());
            for _ in 0..2000 {
                self.step().await;
                let s = self.sockets.get_mut::<tcp::Socket>(h);
                if !sent && s.can_send() {
                    s.send_slice(request).unwrap();
                    sent = true;
                }
                while s.can_recv() {
                    s.recv(|b| {
                        got.extend_from_slice(b);
                        (b.len(), ())
                    })
                    .unwrap();
                }
                if sent && !s.may_recv() {
                    s.close();
                    return got;
                }
            }
            panic!("the connection didn't finish; got {:?}", String::from_utf8_lossy(&got));
        }
    }

    async fn endpoint(ports: Ports) -> (Keys, SocketAddr, Arc<Recorder>) {
        let dir = tempfile::tempdir().unwrap();
        let recorder = Arc::new(Recorder::new());
        recorder.active.store(true, std::sync::atomic::Ordering::Relaxed);
        let engine = Arc::new(Engine::new(Authority::load(dir.path(), None).unwrap(), recorder.clone()).unwrap());
        let keys = Keys::generate();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = udp.local_addr().unwrap();
        tokio::spawn(run(engine, udp, keys.clone(), ports));
        (keys, addr, recorder)
    }

    #[tokio::test]
    async fn a_connection_on_another_port_passes_through() {
        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = echo.accept().await.unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
            s.write_all(b"!").await.unwrap();
        });
        let (keys, server, recorder) = endpoint(Ports::default()).await;
        let mut phone = Phone::new(&keys, server).await;
        let got = phone.exchange(SocketAddrV4::new(Ipv4Addr::LOCALHOST, echo_port), b"hello").await;
        assert_eq!(got, b"hello!");
        assert!(recorder.list(0).unwrap().transactions.is_empty());
    }

    #[tokio::test]
    async fn an_http_request_is_read_and_recorded() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = upstream.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /items?q=milk HTTP/1.1"));
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"price\":42}\n").await.unwrap();
        });
        let (keys, server, recorder) = endpoint(Ports { http: vec![port], tls: vec![] }).await;
        let mut phone = Phone::new(&keys, server).await;
        let got = phone.exchange(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port), format!("GET /items?q=milk HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).await;
        let got = String::from_utf8_lossy(&got);
        assert!(got.starts_with("HTTP/1.1 200 OK"), "{got}");
        assert!(got.ends_with("{\"price\":42}\n"), "{got}");
        let list = recorder.list(0).unwrap();
        assert_eq!(list.transactions.len(), 1);
        let tx = &list.transactions[0];
        assert_eq!((tx.url.as_str(), tx.status, tx.state.as_str()), (format!("http://127.0.0.1:{port}/items?q=milk").as_str(), Some(200), "completed"));
        assert_eq!(recorder.detail(&tx.id).unwrap().response_body.text(), Some("{\"price\":42}\n"));
    }

    #[test]
    fn a_udp_packet_reads_back() {
        let p = udp_packet(SocketAddrV4::new(Ipv4Addr::new(1, 1, 1, 1), 53), SocketAddrV4::new(PHONE_IP, 5353), b"answer");
        let ip = Ipv4Packet::new_checked(&p[..]).unwrap();
        assert!(ip.verify_checksum());
        let udp = UdpPacket::new_checked(ip.payload()).unwrap();
        assert!(udp.verify_checksum(&IpAddress::Ipv4(ip.src_addr()), &IpAddress::Ipv4(ip.dst_addr())));
        assert_eq!((udp.src_port(), udp.dst_port(), udp.payload()), (53, 5353, &b"answer"[..]));
    }

    #[test]
    fn the_phones_config_names_the_macs_key_and_address() {
        let keys = Keys::generate();
        let config = phone_config(&keys, "192.168.1.20:51820");
        assert!(config.contains("Endpoint = 192.168.1.20:51820"));
        assert!(config.contains("Address = 10.233.0.2/32"));
        use base64::Engine as _;
        assert!(config.contains(&base64::engine::general_purpose::STANDARD.encode(Keys::public(&keys.server))));
        assert!(!config.contains(&base64::engine::general_purpose::STANDARD.encode(keys.server)));
    }
}
