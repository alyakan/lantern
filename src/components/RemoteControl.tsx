import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { keyIdFromFile, lastSeen, LANTERN_TEAM_ID, timeLeft, type PairView, type RemoteView } from "../lib/remoteControl";

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
  // A code that was used (a phone paired, or someone tried it) is gone from the backend: it goes from the screen too.
  const [used, setUsed] = useState(false);
  useEffect(() => {
    const refresh = () =>
      api.remoteSettings().then(
        (v) => {
          setView(v);
          setPair((p) => {
            if (p && !v.pairing) setUsed(true);
            return v.pairing ? p : null;
          });
        },
        (e) => setError(errText(e)),
      );
    refresh();
    const unlisten = api.onRemoteChanged(refresh).catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
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
        setUsed(false);
        setTick(now());
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    if (!pair) return;
    navigator.clipboard.writeText(pair.link).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => setError(`Couldn't copy the link: ${errText(e)}`),
    );
  };
  const cancelPair = () => {
    setPair(null);
    void api.remotePairCancel().catch(() => {});
  };
  // The push key for the lock-screen cards: the file is chosen, its Key ID read from its name, then confirmed.
  const [keyForm, setKeyForm] = useState<{ path: string; keyId: string; teamId: string } | null>(null);
  const chooseKey = () =>
    open({ multiple: false, directory: false, filters: [{ name: "Apple push key", extensions: ["p8"] }] }).then(
      (picked) => {
        if (typeof picked !== "string") return;
        setKeyForm({ path: picked, keyId: keyIdFromFile(picked) ?? "", teamId: LANTERN_TEAM_ID });
      },
      (e) => setError(errText(e)),
    );
  const importKey = () => {
    if (!keyForm) return;
    api.remoteSetLiveKey(keyForm.path, keyForm.keyId.trim(), keyForm.teamId.trim()).then(
      (v) => {
        setView(v);
        setError(null);
        setKeyForm(null);
      },
      (e) => setError(errText(e)),
    );
  };

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Remote control</h2>
          <p className="mode-guide-summary">Paired phones can see your open chats, answer their cards, send messages and wake sleeping chats, on the same Wi-Fi as this Mac or from anywhere over Tailscale.</p>
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
            {view.enabled && !view.listening && (
              <p className="settings-error" role="status">
                It's on, but Lantern isn't listening for phones right now. Turn it off and on again; if that doesn't help, another app may be using its port.
              </p>
            )}
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
                    <div className="remote-pair-actions">
                      <button onClick={copyLink}>{copied ? "Copied" : "Copy the link"}</button>
                      <button onClick={cancelPair}>Stop pairing</button>
                    </div>
                    <p className="settings-muted">The link is the same code as text, for a phone that can't scan the screen: paste it in Lantern on the phone.</p>
                  </div>
                </div>
              ) : (
                <>
                  {used && <p className="settings-muted">That code was used. Show a new one to pair another phone.</p>}
                  <button onClick={startPair}>{used ? "Show a new code" : "Show a pairing code"}</button>
                </>
              )}
              <span className="settings-muted">If the phone can't connect, check that macOS lets Lantern accept incoming connections (System Settings › Network › Firewall).</span>
            </section>
          )}
          {view.enabled && (
            <section className="general-section" aria-labelledby="remote-away">
              <h3 id="remote-away" className="general-title">
                Away from home
              </h3>
              {view.tailnet.length > 0 ? (
                <span className="settings-muted">
                  Tailscale is on: phones on your tailnet reach this Mac at {view.tailnet.join(", ")}. Install Tailscale on the phone and sign in to the same account. A phone that is paired already picks the address up the next time it connects.
                </span>
              ) : (
                <span className="settings-muted">Tailscale isn't on this Mac. Install it here and on the phone, sign in to the same account on both, and a phone can reach this Mac from anywhere. Show a new pairing code after that.</span>
              )}
              <label className="general-option">
                <input type="checkbox" checked={view.keep_awake} onChange={(e) => act(api.remoteSetKeepAwake(e.target.checked))} />
                <span>Keep this Mac awake while Remote control is on</span>
              </label>
              <span className="settings-muted">A sleeping Mac can't be reached, and a phone can't wake it. This stops the Mac sleeping from idling (the screen can still turn off, and closing the lid still sleeps it). Off, the Mac sleeps on its usual schedule.</span>
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
          <section className="general-section" aria-labelledby="remote-auto">
            <h3 id="remote-auto" className="general-title">
              Auto from a phone
            </h3>
            <label className="general-option">
              <input type="checkbox" checked={view.allow_phone_auto} onChange={(e) => act(api.remoteSetAllowAuto(e.target.checked))} />
              <span>Let paired phones use Auto</span>
            </label>
            <span className="settings-muted">
              Off, chats a phone starts are on Ask and it can't switch a chat to Auto. On, a phone can choose Auto, where a classifier approves most actions and nobody has to be at the Mac. Turning it off doesn't change chats already on Auto.
            </span>
          </section>
          <section className="general-section" aria-labelledby="remote-notify">
            <h3 id="remote-notify" className="general-title">
              Notifications
            </h3>
            <label className="general-option">
              <input type="checkbox" checked={view.show_titles} onChange={(e) => act(api.remoteSetShowTitles(e.target.checked))} />
              <span>Show chat titles in notifications</span>
            </label>
            <span className="settings-muted">Notifications pass through Apple's, Google's and Expo's servers. Off, they say the project's name and that a chat needs you or finished. On, they also give the chat's title, and name the tool, the program of a command (never what it is given) or the file's name that a chat wants to use.</span>
            <label className="general-option">
              <input type="checkbox" checked={view.rich_notifications} onChange={(e) => act(api.remoteSetRichNotifications(e.target.checked))} />
              <span>Show what Claude asks in notifications</span>
            </label>
            <span className="settings-muted">
              On, a notification that asks to run a command, change a file or use a tool shows the whole command, the file and what changes, or the question, so you can judge it from the lock screen. It is encrypted on this Mac with a key your phone made, so Apple's servers carry only bytes they can't read; the phone decrypts it itself. Only a phone on a recent build of the app can, and any other still gets the short words. It is on your lock screen, so the phone's own Show Previews setting (Settings › Notifications) still applies.
            </span>
          </section>
          <section className="general-section" aria-labelledby="remote-live">
            <h3 id="remote-live" className="general-title">
              Lock screen cards
            </h3>
            <span className="settings-muted">
              A phone can show a card on its lock screen for the chat you last messaged: working, needs you, done. This Mac keeps it right by sending Apple a small update each time, signed with a push key you made at developer.apple.com, so it only updates while this Mac is awake. A card says the project's name and what state it is in, with the chat's title, how far its plan has got, what it needs in a word and the plan's usage when it has them, never a command, a file or a question.
            </span>
            <p>{view.live_key ? `Push key: ${view.live_key}` : "No push key yet, so no card is kept up to date."}</p>
            {keyForm ? (
              <div className="remote-pair-actions">
                <label>
                  Key ID
                  <input aria-label="Key ID" value={keyForm.keyId} maxLength={10} onChange={(e) => setKeyForm({ ...keyForm, keyId: e.target.value })} />
                </label>
                <label>
                  Team ID
                  <input aria-label="Team ID" value={keyForm.teamId} maxLength={10} onChange={(e) => setKeyForm({ ...keyForm, teamId: e.target.value })} />
                </label>
                <button onClick={importKey}>Import</button>
                <button onClick={() => setKeyForm(null)}>Cancel</button>
              </div>
            ) : (
              <button onClick={chooseKey}>{view.live_key ? "Replace the push key…" : "Import the push key…"}</button>
            )}
            <span className="settings-muted">Choose the AuthKey_….p8 file. It is kept in this Mac's Keychain; the file itself is left where it is, so keep your own backup of it.</span>
            {view.live_last && <span className="settings-muted">Apple last said: {view.live_last}</span>}
          </section>
        </>
      )}
    </>
  );
}
