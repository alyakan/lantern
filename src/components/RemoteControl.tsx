import { useEffect, useState } from "react";
import { api } from "../api";
import { lastSeen, timeLeft, type PairView, type RemoteView } from "../lib/remoteControl";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/**
 * Settings › Remote control: let paired phones see the open chats, answer their cards, send messages and wake sleeping
 * chats. Off until the user turns it on; pairing is a QR code that works once, for five minutes.
 */
export function RemoteControl({ now = Date.now }: { now?: () => number }) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [pair, setPair] = useState<PairView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(now());
  useEffect(() => {
    api.remoteSettings().then(setView, (e) => setError(errText(e)));
  }, []);
  // The code's countdown; it goes when it runs out.
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => {
      const at = now();
      setTick(at);
      if (at >= pair.expires_at) setPair(null);
    }, 1000);
    return () => clearInterval(t);
  }, [pair]);
  // Leaving the page ends a pairing in progress: the code shouldn't stay usable unseen.
  useEffect(() => () => void api.remotePairCancel().catch(() => {}), []);

  const act = (p: Promise<RemoteView>) =>
    p.then(
      (v) => {
        setView(v);
        setError(v.warning ?? null);
      },
      (e) => setError(errText(e)),
    );
  const setEnabled = (on: boolean) => {
    if (!on) setPair(null);
    act(api.remoteSetEnabled(on));
  };
  const startPair = () =>
    api.remotePair().then(
      (p) => {
        setPair(p);
        setTick(now());
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  const cancelPair = () => {
    setPair(null);
    void api.remotePairCancel().catch(() => {});
  };

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Remote control</h2>
          <p className="mode-guide-summary">Paired phones can see your open chats, answer their cards, send messages and wake sleeping chats, while they're on the same Wi-Fi as this Mac.</p>
          <p className="settings-muted">A message to a chat on Auto can run commands on this Mac, so pair only your own devices. Everything between the phone and this Mac is encrypted end to end.</p>
        </div>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {view && (
        <>
          <section className="general-section" aria-labelledby="remote-on">
            <h3 id="remote-on" className="general-title">
              Phones
            </h3>
            <label className="general-option">
              <input type="checkbox" checked={view.enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>Let paired phones control Lantern</span>
            </label>
            <span className="settings-muted">While this is off, nothing on this Mac listens for phones.</span>
          </section>
          {view.enabled && (
            <section className="general-section remote-pair" aria-labelledby="remote-pair">
              <h3 id="remote-pair" className="general-title">
                Pair a phone
              </h3>
              {pair ? (
                <div className="remote-pair-code">
                  <img className="remote-qr" alt="Pairing code" src={`data:image/svg+xml;utf8,${encodeURIComponent(pair.svg)}`} />
                  <div>
                    <p>Open Lantern on your phone and scan this code. It works once, and stops working in {timeLeft(pair.expires_at, tick)}.</p>
                    <button onClick={cancelPair}>Stop pairing</button>
                  </div>
                </div>
              ) : (
                <button onClick={startPair}>Show a pairing code</button>
              )}
            </section>
          )}
          <section className="general-section" aria-labelledby="remote-devices">
            <h3 id="remote-devices" className="general-title">
              Paired phones
            </h3>
            {view.devices.length === 0 ? (
              <span className="settings-muted">No phones yet.</span>
            ) : (
              <ul className="remote-devices">
                {view.devices.map((d) => (
                  <li key={d.id}>
                    <span>
                      {d.name}
                      <span className="settings-muted"> {lastSeen(d.last_seen, tick)}</span>
                    </span>
                    <button aria-label={`Remove ${d.name}`} onClick={() => act(api.remoteRemoveDevice(d.id))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="settings-muted">A removed phone is disconnected at once, and can't connect again until it pairs again.</span>
          </section>
          <section className="general-section" aria-labelledby="remote-notify">
            <h3 id="remote-notify" className="general-title">
              Notifications
            </h3>
            <label className="general-option">
              <input type="checkbox" checked={view.show_titles} onChange={(e) => act(api.remoteSetShowTitles(e.target.checked))} />
              <span>Show chat titles in notifications</span>
            </label>
            <span className="settings-muted">Notifications pass through Apple's, Google's and Expo's servers. Off, they only say that a chat needs you or finished.</span>
          </section>
        </>
      )}
    </>
  );
}
