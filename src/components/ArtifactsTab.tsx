import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { artifactUrl, themeVars, type Artifact, type ArtifactListing } from "../lib/artifacts";
import { usePrefersDark } from "../lib/theme";
import { relativeTime } from "../lib/time";
import { Md } from "./Md";
import { TabEmpty } from "./TabEmpty";

/**
 * The folder's artifacts, read when the tab opens, when the window comes back to the front (a file may have been written
 * meanwhile) and when `refreshKey` changes (Claude edited a file).
 */
function useArtifacts(folder: string, refreshKey: number) {
  const [data, setData] = useState<(ArtifactListing & { folder: string }) | null>(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    const mine = ++latest.current;
    // A slower, older read never lands over a newer one.
    api.artifactsList(folder).then(
      (listing) => latest.current === mine && setData({ ...listing, folder }),
      () => {},
    );
  }, [folder]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  return { data: data?.folder === folder ? data : null, reload: load };
}

/**
 * Sends the app's theme to the backend for `lantern.css`, now and whenever it changes, and counts the changes so the frame
 * loads again with the new one.
 */
function useArtifactTheme(): number {
  const dark = usePrefersDark();
  const [stamp, setStamp] = useState(0);
  const sent = useRef("");
  useEffect(() => {
    const send = () => {
      const vars = themeVars(dark);
      const text = JSON.stringify(vars);
      // Only a real change loads the frame again (and loses what the page was showing).
      if (text === sent.current) return;
      sent.current = text;
      api.artifactsTheme(vars).then(() => setStamp((n) => n + 1), () => {});
    };
    send();
    // A custom theme sets its colours on <html> itself.
    const watch = new MutationObserver(send);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-scheme"] });
    return () => watch.disconnect();
  }, [dark]);
  return stamp;
}

/** Which artifact each folder was left on, kept while the tab is away. */
const chosen = new Map<string, string>();

/**
 * `open`: an artifact to bring up (Claude just wrote it); `key` changes for every request. `busy`: Claude is in a turn in
 * this chat. `onRefresh`: asks Claude to gather an artifact's data again (absent: Claude isn't free to ask).
 */
export function ArtifactsTab({ folder, refreshKey, open, busy = false, onRefresh }: { folder: string; refreshKey: number; open?: { name: string; key: number } | null; busy?: boolean; onRefresh?: (name: string) => void }) {
  const { data, reload } = useArtifacts(folder, refreshKey);
  const [picked, setPicked] = useState<string | null>(() => chosen.get(folder) ?? null);
  const theme = useArtifactTheme();
  // The artifact Claude was asked to refresh, until the turn that does it ends.
  const [refreshing, setRefreshing] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    chosen.set(folder, open.name);
    setPicked(open.name);
    reload();
  }, [open?.key]);
  // A turn ended: read again, since Claude may have rewritten an artifact with a script, which isn't an edit the app sees.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setRefreshing(null);
      reload();
    }
    wasBusy.current = busy;
  }, [busy]);
  if (!data) return <div className="tests-note dash-loading">Loading…</div>;
  if (data.items.length === 0) return <ArtifactsEmpty />;
  const current = data.items.find((a) => a.name === picked) ?? data.items[0];
  const pick = (name: string) => {
    chosen.set(folder, name);
    setPicked(name);
  };
  return (
    <>
      <div className="dash-head">
        <div className="dash-head-text">
          {data.items.length > 1 ? (
            <select className="dash-pick" aria-label="Artifact" value={current.name} onChange={(e) => pick(e.target.value)}>
              {data.items.map((a) => (
                <option key={a.name} value={a.name}>
                  {title(a)}
                </option>
              ))}
            </select>
          ) : (
            <span className="dash-head-title">{title(current)}</span>
          )}
          <span className="dash-bar-file">
            {current.name} · {relativeTime(current.modified)}
          </span>
        </div>
        {refreshing === current.name ? (
          <span className="tests-note artifact-refreshing" role="status">
            Refreshing…
          </span>
        ) : (
          onRefresh && (
            <button
              className="ghost artifact-refresh"
              onClick={() => {
                setRefreshing(current.name);
                onRefresh(current.name);
              }}
              title="Ask Claude in this chat to gather this artifact's data again and rewrite it; it shows again when Claude is done"
            >
              Refresh data
            </button>
          )
        )}
        <button className="ghost dash-reload" aria-label="Reload" onClick={reload} title="Read the artifacts folder and this artifact again">
          ↻
        </button>
      </div>
      <Viewer key={`${folder}\n${current.name}`} folder={folder} artifactKey={data.key} scripts={data.scripts} artifact={current} theme={theme} />
    </>
  );
}

/** An artifact's name as the picker shows it: its file name without the extension. */
function title(a: Artifact): string {
  const file = a.name.split("/").pop() ?? a.name;
  return file.replace(/\.[^.]+$/, "") || file;
}

function Viewer({ folder, artifactKey, scripts, artifact, theme }: { folder: string; artifactKey: string; scripts: boolean; artifact: Artifact; theme: number }) {
  if (artifact.kind === "html" || artifact.kind === "svg") {
    return (
      <div className="artifact-body">
        {!scripts && artifact.kind === "html" && <div className="tests-note">This page's scripts are off: Lantern couldn't switch off the parts of WebKit (WebRTC, preconnect) they could reach the internet through.</div>}
        {/* Scripts run, with an opaque origin: no app, no files, no network (the scheme's own policy), no popups, forms or navigating the app. */}
        <iframe className="artifact-frame" title={artifact.name} sandbox={scripts ? "allow-scripts" : ""} referrerPolicy="no-referrer" src={artifactUrl(artifactKey, artifact.name, artifact.modified * 1000 + theme)} />
      </div>
    );
  }
  return <TextArtifact folder={folder} artifact={artifact} />;
}

/** Markdown and Mermaid are drawn by the app itself, as the chat draws them. */
function TextArtifact({ folder, artifact }: { folder: string; artifact: Artifact }) {
  const [text, setText] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.artifactsRead(folder, artifact.name).then(
      (t) => live && setText({ ok: true, text: t }),
      (e) => live && setText({ ok: false, text: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [folder, artifact.name, artifact.modified]);
  if (!text) return <div className="tests-note dash-loading">Loading…</div>;
  if (!text.ok) return <div className="tests-note">{text.text}</div>;
  const source = artifact.kind === "mermaid" ? "```mermaid\n" + text.text + "\n```" : text.text;
  return (
    <div className="artifact-body artifact-text">
      <Md>{source}</Md>
    </div>
  );
}

function ArtifactsEmpty() {
  return (
    <TabEmpty title="Artifacts">
      <p>Artifacts are pages Claude makes to show you something: an architecture map, a flow, a chart, a report.</p>
      <p>Ask Claude for one (for example, “draw the auth flow as an artifact”). It is saved in .lantern/artifacts/ in this folder and opens here. Pages run in a sandbox with no network and no access to Lantern or your files.</p>
    </TabEmpty>
  );
}
