import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  Code2,
  Copy,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Layers2,
  LoaderCircle,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  AlertTriangle,
  Smartphone,
  Terminal,
  X,
} from "lucide-react";
import type { Detail, Project, Tool } from "../core/types";
import type { RestorePreview } from '../git/restore';
import { api, copy } from "./api";
import {SupportHandoff} from './SupportHandoff';
import "../styles/app.css";

const toolNames: Record<Tool, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini",
  manual: "Manual / Generic",
};
function IconBrand() {
  return (
    <span className="brand-mark">
      <Layers2 size={22} strokeWidth={1.7} />
    </span>
  );
}
function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="button subtle small"
      type="button"
      onClick={async () => {
        try {
          await copy(value);
          setCopied(true);
          setError(false);
        } catch {
          setError(true);
        }
      }}
      title={
        error
          ? "Clipboard unavailable. Select and copy the text manually."
          : label
      }
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
      {error ? "Select text to copy" : copied ? "Copied" : label}
    </button>
  );
}
function Tools({
  value,
  onChange,
}: {
  value: Tool;
  onChange: (t: Tool) => void;
}) {
  return (
    <div className="tool-picker" role="group" aria-label="Existing coding tool">
      {(Object.keys(toolNames) as Tool[]).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={value === t}
          className={value === t ? "selected" : ""}
          onClick={() => onChange(t)}
        >
          <Code2 size={15} />
          {toolNames[t]}
          {value === t && <Check size={13} />}
        </button>
      ))}
    </div>
  );
}
function Shell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await api<{
        projects: Project[];
        warnings: string[];
        workspace: string;
      }>("/projects");
      setProjects(r.projects);
      setWorkspace(r.workspace);
      setWarning(r.warnings.join(" "));
    } catch (e) {
      setWarning("Cannot reach the local server. " + (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      <aside className="sidebar">
        <Link to="/" className="wordmark">
          <IconBrand />
          <span>
            {DISPLAY_NAMES.umbrella}<small>{DISPLAY_NAMES.build.toUpperCase()}</small>
          </span>
        </Link>
        <Link to="/" className="new-project">
          <Plus size={17} /> New project <span>↗</span>
        </Link>
        <NavLink to="/" end className="nav-item all-projects">
          <Layers2 size={17} /> All projects <span>{projects.length}</span>
        </NavLink>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className={warning ? "offline" : ""} /> {loading ? "Connecting locally…" : warning ? "Workspace needs attention" : "On your machine. In your hands."}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        {warning && (
          <div role="alert" className="banner warning">
            {warning}
            <button onClick={() => void refresh()} className="button small">
              Retry
            </button>
          </div>
        )}
        <Routes>
          <Route
            path="/"
            element={
              <Home
                projects={projects}
                workspace={workspace}
                refresh={refresh}
                loading={loading}
              />
            }
          />
          <Route
            path="/project/:id"
            element={<Workspace refresh={refresh} />}
          />
          <Route
            path="*"
            element={
              <div className="not-found" id="main-content" tabIndex={-1}>
                <h1>This page wandered off.</h1>
                <Link to="/">Back to your projects</Link>
              </div>
            }
          />
        </Routes>
      </div>
    </div>
  );
}
function Home({
  projects,
  workspace,
  refresh,
  loading,
}: {
  projects: Project[];
  workspace: string;
  refresh: () => Promise<void>;
  loading: boolean;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"create" | "import">("create");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [reference, setReference] = useState("");
  const [tool, setTool] = useState<Tool>("codex");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!window.location.hash.startsWith('#setup=')) return;
    try {
      if (window.location.hash.length > 8192) throw Error('Setup context is too large.');
      const input = JSON.parse(decodeURIComponent(window.location.hash.slice(7)));
      if (typeof input.projectName === 'string' && input.projectName.length <= 80) setName(input.projectName);
      if (typeof input.desiredOutcome === 'string' && input.desiredOutcome.length <= 1000) setBrief(input.desiredOutcome +
        (typeof input.audience === 'string' && input.audience.length <= 200 ? '\n\nAudience: ' + input.audience : ''));
      if (Object.hasOwn(toolNames, input.selectedAgentAdapterId)) setTool(input.selectedAgentAdapterId);
      if (input.startingPoint === 'REPO') setMode('import');
      history.replaceState(null, '', window.location.pathname);
    } catch { setError('Setup context could not be read. Enter the project details here.'); }
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const p = await api<Project>(
        mode === "create" ? "/projects" : "/import",
        {
          method: "POST",
          body: JSON.stringify({ name, brief, reference, tool, folder }),
        },
      );
      await refresh();
      navigate("/project/" + p.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="home" id="main-content" tabIndex={-1}>
      <header className="home-top">
        <span>THE LOCAL APP WORKSHOP</span>
        <span className="local-pill">
          <Circle size={8} fill="currentColor" /> Local workspace
        </span>
      </header>
      <section className="intro">
        <div className="eyebrow">
          <span /> AN IDEA IS A GOOD PLACE TO START
        </div>
        <h1>
          Make something
          <br />
          <em>you can call yours.</em>
        </h1>
        <p>
          Your idea. The coding tool you already use. A real app, in a folder you own.
        </p>
        <ol className="build-story" aria-label={`How ${DISPLAY_NAMES.umbrella} works`}>
          <li><span>01</span><div><strong>Give your idea a home.</strong><p>A React project with your brief and references.</p></div></li>
          <li><span>02</span><div><strong>Bring your own coding tool.</strong><p>Continue in Codex, Claude Code, or Cursor.</p></div></li>
          <li><span>03</span><div><strong>See it. Test it. Keep it.</strong><p>Live preview, real checks, every line of source.</p></div></li>
        </ol>
        <p className="ownership-note"><FolderOpen size={17} /> No builder credits. No source lock-in.</p>
      </section>
      <section className="creation-card" aria-label="Create or open a project">
        <div className="creation-tabs">
          <button
            className={mode === "create" ? "active" : ""}
            onClick={() => {
              setMode("create");
              setError("");
            }}
          >
            <Plus size={16} /> Start fresh
          </button>
          <button
            className={mode === "import" ? "active" : ""}
            onClick={() => {
              setMode("import");
              setError("");
            }}
          >
            <FolderOpen size={16} /> Open existing
          </button>
          <span>NO BUILDER CREDITS. NO LOCK-IN.</span>
        </div>
        <form onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy} className="creation-form-fields">
          <div className="creation-fields">
            <div className="form-intro"><span className="eyebrow">{mode === "create" ? "YOUR NEXT PROJECT" : "PICK UP WHERE YOU LEFT OFF"}</span><h2>{mode === "create" ? "Start with a spark." : "Bring your project home."}</h2></div>
            <label className="field-label" htmlFor="project-name">
              Project name
            </label>
            <input
              id="project-name"
              className="name-input"
              placeholder="Give your idea a name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            {mode === "import" && (
              <div className="import-field">
                <label className="field-label" htmlFor="folder-name">
                  Existing folder name in your workspace
                </label>
                <input
                  id="folder-name"
                  placeholder="my-react-project"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  required
                />
                <p>
                  Supports React + Vite with package-lock.json and
                  build/typecheck scripts. Copy your folder into this workspace
                  first. Importing does not install or run anything.
                </p>
              </div>
            )}
            <label className="field-label" htmlFor="product-brief">
              What would you like to build?
            </label>
            <textarea
              id="product-brief"
              placeholder="A quiet, beautiful space for… Describe who it’s for, what it does, and how it should feel."
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              minLength={10}
              maxLength={12000}
              required
              rows={4}
            />
            <span className="field-label reference-label">REFERENCE <span>OPTIONAL</span></span>
            <label className="reference-input">
              <Plus size={16} />
              <input
                aria-label="Design reference path or URL"
                placeholder="A screenshot path or inspiration URL"
                value={reference}
                maxLength={2000}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
            <p className="muted-note">Saved with your brief for your coding tool. No file upload.</p>
          </div>
          <div className="creation-bottom">
            <div>
              <span className="field-label">USE MY EXISTING CODING TOOL</span>
              <Tools value={tool} onChange={setTool} />
            </div>
            <button
              className="button primary create-button"
              disabled={busy || !workspace}
            >
              {busy ? <LoaderCircle className="spin" size={17} /> : null}
              {busy
                ? "Preparing your project…"
                : mode === "create"
                  ? "Create project"
                  : "Open project"}
              <ArrowRight size={17} />
            </button>
          </div>
          </fieldset>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </section>
      <p className="creation-note">
        <ShieldCheck size={14} /> An owned React starter + your brief. Your
        chosen tool implements the idea.
      </p>
      <section className="projects-section">
        <div className="section-heading">
          <h2>
            Your projects{" "}
            <span>{projects.length.toString().padStart(2, "0")}</span>
          </h2>
          <span>STORED LOCALLY. ALWAYS YOURS.</span>
        </div>
        {loading ? <div className="project-loading" aria-live="polite"><LoaderCircle className="spin" size={20} /><div><h3>Reading your workspace…</h3><p>Your projects live on this machine.</p></div></div> : !workspace ? <div className="empty-projects"><AlertTriangle size={24} /><div><h3>Your workspace is unavailable.</h3><p>Retry the local connection above to load your projects.</p></div></div> : projects.length ? (
          <div className="project-grid">
            {projects.map((p, i) => (
              <Link className="project-card" to={"/project/" + p.id} key={p.id}>
                <div className={"project-art tone-" + (i % 3)}>
                  <span className="project-monogram">
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                  <ArrowUpRight size={20} />
                </div>
                <div className="project-card-meta">
                  <h3>{p.name}</h3>
                  <p className="project-excerpt">{p.brief}</p>
                  <p>
                    {toolNames[p.tool]} <span>·</span>{" "}
                    {p.imported ? "Imported source" : "React starter"}
                  </p>
                  <span className="project-owner">
                    <Folder size={13} /> Source owned by you
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-projects">
            <div className="empty-icon">
              <Folder size={24} />
            </div>
            <div>
              <h3>Your first project starts here.</h3>
              <p>
                Give it a name and a brief above. The source stays yours, even when you leave.
              </p>
            </div>
          </div>
        )}
        <details className="workspace-location">
          <summary>
            Project directory <ChevronRight size={13} />
          </summary>
          <code>{workspace || "Connecting to local server…"}</code>
          <p>
            Set LF_WORKSPACE before starting {DISPLAY_NAMES.umbrella} to choose a different
            directory.
          </p>
        </details>
      </section>
    </main>
  );
}
function Workspace({ refresh }: { refresh: () => Promise<void> }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [brief, setBrief] = useState("");
  const [reference, setReference] = useState("");
  const [tool, setTool] = useState<Tool>("codex");
  const [tab, setTab] = useState<"preview" | "source" | "checks">("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [frameKey, setFrameKey] = useState(0);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restoreTarget,setRestoreTarget]=useState('HEAD');
  const [restorePaths,setRestorePaths]=useState('');
  const [restorePreview,setRestorePreview]=useState<RestorePreview|null>(null);
  const [restoreReviewed,setRestoreReviewed]=useState(false);
  const [flowName,setFlowName]=useState("");
  const [flowPath,setFlowPath]=useState("tests/critical.spec.ts");
  const [flowOutcome,setFlowOutcome]=useState("");
  const [flowPreserve,setFlowPreserve]=useState("Preserve existing source and data.");
  const [trustChecked, setTrustChecked] = useState(false);
  const load = useCallback(
    async (initial = false) => {
      const d = await api<Detail>("/projects/" + id);
      setDetail(d);
      if (initial) {
        setBrief(d.project.brief);
        setReference(d.project.reference);
        setTool(d.project.tool);
        setFlowName(d.project.flow?.name||"");setFlowPath(d.project.flow?.testPath||"tests/critical.spec.ts");setFlowOutcome(d.project.flow?.outcome||"");setFlowPreserve(d.project.flow?.preserve||"Preserve existing source and data.");
      }
      return d;
    },
    [id],
  );
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError("");
    setNotice("");
    setTrustChecked(false);
    const controller = new AbortController();
    api<Detail>("/projects/" + id, { signal: controller.signal })
      .then((d) => {
        if (live) {
          setDetail(d);
          setBrief(d.project.brief);
          setReference(d.project.reference);
          setTool(d.project.tool);
        setFlowName(d.project.flow?.name||"");setFlowPath(d.project.flow?.testPath||"tests/critical.spec.ts");setFlowOutcome(d.project.flow?.outcome||"");setFlowPreserve(d.project.flow?.preserve||"Preserve existing source and data.");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [id]);
  useEffect(() => {
    if (
      !detail ||
      (!pending &&
        detail.runtime.status !== "running" &&
        detail.runtime.status !== "starting")
    )
      return;
    let live = true;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await api<Detail>("/projects/" + id);
        if (live) setDetail(d);
      } catch {
        /* Foreground actions surface connection errors. */
      } finally {
        inFlight = false;
      }
    }, 1800);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, pending, detail?.runtime.status]);
  async function action(name: string) {
    setPending(name);
    if (name === "verify" || name === "install") setTab("checks");
    setError("");
    setNotice("");
    try {
      const r = await api<{ ok: boolean; message: string }>(
        "/projects/" + id + "/action",
        { method: "POST", body: JSON.stringify({ action: name }) },
      );
      if (r.ok) setNotice(r.message);
      else setError(r.message);
      if (name === "verify" || name === "install") setTab("checks");
      await load();
    } catch (e) {
      setError((e as Error).message);
      try {
        await load();
      } catch {
        /* Keep error visible. */
      }
    } finally {
      setPending("");
    }
  }
  async function save() {
    if (!detail) return;
    setPending("save");
    setError("");
    try {
      await api("/projects/" + id, {
        method: "PUT",
        body: JSON.stringify({
          name: detail.project.name,
          brief,
          reference,
          tool,
        }),
      });
      await load();
      await refresh();
      setNotice(
        "Brief saved to .launchforge/brief.md. Continue in your coding tool.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
    }
  }
  async function restore(apply: boolean) {
    setPending(apply?'Restoring source':'Reviewing restore');setError('');setNotice('');
    try {
      if(apply){
        if(!restorePreview)return;
        await api('/projects/'+id+'/restore/apply',{method:'POST',body:JSON.stringify({previewToken:restorePreview.previewToken,statusIdentity:restorePreview.statusIdentity,reviewed:restoreReviewed})});
        setRestorePreview(null);setRestoreReviewed(false);
        setNotice('Source restored. Preview stopped. Start preview and run fresh checks; unrelated index/worktree files were preserved.');
      }else{
        setRestorePreview(null);setRestoreReviewed(false);
        setRestorePreview(await api<RestorePreview>('/projects/'+id+'/restore/preview',{method:'POST',body:JSON.stringify({target:restoreTarget,paths:restorePaths.split('\n').map(p=>p.trim()).filter(Boolean)})}));
      }
    }catch(e){setRestorePreview(null);setRestoreReviewed(false);setError((e as Error).message);}
    finally{await load().catch(()=>{});setPending('');}
  }
  async function close() {
    if (detail?.runtime.status === "running") {
      await action("stop");
    }
    navigate("/");
  }
  if (!detail)
    return (
      <main className="loading-state" id="main-content" tabIndex={-1}>
        {error ? (
          <>
            <AlertTriangle size={32} /><h1>We couldn’t open this project.</h1>
            <p role="alert">{error}</p>
            <Link to="/">Back to projects</Link>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={32} />
            <h1>Opening your workspace…</h1><p>Reading your brief, source, and project status.</p><div className="loading-lines" aria-hidden="true"><span /><span /><span /></div>
          </>
        )}
      </main>
    );
  const p = detail.project;
  const disabled = Boolean(pending || detail.busy);
  const installed = p.checks?.install?.status === "passed";
  const dirty =
    brief !== p.brief || reference !== p.reference || tool !== p.tool;
  const operation = pending || detail.busy;
  const previewStarting = operation === "preview" || detail.runtime.status === "starting";
  const previewFailed = detail.runtime.status === "failed";
  const checkKeys = ["typecheck", "build", "test"] as const;
  const currentChecks=p.verification?.checks||p.checks;
  const failedCheck = checkKeys.find((key) => currentChecks?.[key]?.status === "failed");
  const allChecksPassed = detail.verificationState.startsWith("CURRENT") && checkKeys.every((key) => currentChecks?.[key]?.status === "passed");
  const gitLabel = detail.git.branch === "No project Git repository" ? "No Git repository" : detail.git.files === "Working tree clean" ? "Working tree clean" : "Uncommitted changes";
  return (
    <main className="workbench" id="main-content" tabIndex={-1}>
      <header className="workbench-header">
        <div className="breadcrumb">
          <Link to="/" aria-label="All projects">
            <ArrowLeft size={17} />
          </Link>
          <span>Projects</span>
          <ChevronRight size={14} />
          <strong>{p.name}</strong>
          <span className="draft-pill">
            {p.imported ? "Imported" : "Starter"}
          </span>
        </div>
        <button
          className="button subtle small"
          disabled={disabled}
          onClick={() => void close()}
        >
          <X size={15} /> Close project
        </button>
      </header>
      <div className="workbench-title">
        <div>
          <span className="eyebrow">YOUR PROJECT WORKSHOP</span>
          <h1>
            {p.name}
            <span
              className="saved-dot"
              aria-hidden="true"
              title="Saved on disk"
            />
          </h1>
        </div>
        <div className="workbench-actions">
          <button
            className="button"
            disabled={disabled || !detail.trusted}
            onClick={() => void action("verify")}
          >
            <CheckCheck size={16} /> Run checks
          </button>
          <button
            className="button primary"
            disabled={
              disabled || !detail.trusted || detail.runtime.status === "running"
            }
            onClick={() => void action(installed ? "preview" : "install")}
          >
            {pending ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Play size={15} />
            )}{" "}
            {pending
              ? pending === "install"
                ? "Installing…"
                : pending === "verify"
                  ? "Checking…"
                  : "Working…"
              : detail.runtime.status === "running"
                ? "Preview running"
                : installed
                  ? "Start preview"
                  : "Install dependencies"}
          </button>
        </div>
      </div>
      <div className="project-context">
        <span className="owned-path"><FolderOpen size={15} /><code>{detail.path}</code></span>
        <button className="context-link" onClick={() => setTab("source")}><GitBranch size={15} />{detail.git.branch === "No project Git repository" ? "Git not initialized" : detail.git.branch}<span>· {gitLabel}</span><ArrowUpRight size={13} /></button>
        <button data-verification-state={detail.verificationState} className={"context-link check-summary " + (failedCheck ? "failed" : allChecksPassed ? "passed" : "")} onClick={() => setTab("checks")}><CheckCheck size={15} />{operation === "verify" ? "Checks running…" : failedCheck ? `${failedCheck} failed` : allChecksPassed ? detail.verificationState : detail.verificationState === "STALE" ? "STALE · source changed" : "Checks not yet complete"}<ArrowUpRight size={13} /></button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          <span>{error.trim().split("\n")[0]}</span>
          {error.includes("\n") && <details><summary>Full error output</summary><pre>{error}</pre></details>}
        </div>
      )}
      {notice && (
        <div className="banner success" role="status">
          {notice}
        </div>
      )}
      {operation && <div className="operation-banner" aria-live="polite"><LoaderCircle className="spin" size={17} /><span>{operation === "install" ? "Installing locked dependencies from npm. The first run may take a moment." : operation === "verify" ? "Running typecheck → production build → project tests. Results appear as each command finishes." : previewStarting ? "Starting your local preview. Waiting for the server to respond…" : "Updating your project…"}</span></div>}
      {!detail.trusted && (
        <div className="trust-panel">
          <ShieldCheck size={22} />
          <div>
            <strong>Make this a trusted workspace</strong>
            <p>
              Preview and checks execute this project’s code on your machine.
              Only continue with code you trust. Dependencies come from npm; AI
              stays in your chosen tool.
            </p>
            <label>
              <input
                type="checkbox"
                checked={trustChecked}
                onChange={(e) => setTrustChecked(e.target.checked)}
              />{" "}
              I trust this project’s code for this session.
            </label>
          </div>
          <button
            className="button"
            disabled={!trustChecked || disabled}
            onClick={() => void action("trust")}
          >
            Trust project
          </button>
        </div>
      )}
      <div className="editor-layout">
        <section className="brief-panel">
          <div className="panel-heading">
            <span>
              <FileCode2 size={16} /> Brief & handoff
            </span>
            <span className="tiny-status">{dirty ? "UNSAVED" : "SAVED"}</span>
          </div>
          <div className="brief-body">
            <label className="field-label" htmlFor="edit-brief">
              WHAT YOU’RE MAKING
            </label>
            <textarea
              id="edit-brief"
              value={brief}
              rows={5}
              maxLength={12000}
              onChange={(e) => setBrief(e.target.value)}
            />
            <label className="field-label" htmlFor="edit-reference">
              DESIGN REFERENCE
            </label>
            <input
              id="edit-reference"
              value={reference}
              placeholder="Path or URL (optional)"
              maxLength={2000}
              onChange={(e) => setReference(e.target.value)}
            />
            <p className="muted-note">
              Reference paths are saved for your tool. {DISPLAY_NAMES.umbrella} does not read
              or upload the reference.
            </p>
            <label className="field-label">CONTINUE WITH</label>
            <Tools value={tool} onChange={setTool} />
            <button
              className="button save-brief"
              disabled={disabled || !dirty || brief.trim().length < 10}
              onClick={() => void save()}
            >
              {dirty ? "Save brief & handoff" : "Brief saved"}
              {dirty ? <ArrowRight size={15} /> : <Check size={15} />}
            </button>
          </div>
          <SupportHandoff key={p.id + p.updatedAt + (p.verification?.id ?? '') + (detail.resume?.sourceIdentity ?? '')} detail={detail} unsaved={dirty} />
          <details className="handoff">
            <summary>Legacy open-folder instructions</summary>
            <span className="eyebrow">YOUR TOOL. YOUR SUBSCRIPTION.</span>
            <h3>
              Use with {toolNames[p.tool]} <ArrowUpRight size={17} />
            </h3>
            <p>
              Open this folder in {toolNames[p.tool]}, or copy the command if
              its CLI is installed.
            </p>
            <code>{detail.handoff.command}</code>
            <div className="copy-row">
              <CopyButton value={detail.handoff.command} label="Copy command" />
              <CopyButton value={detail.handoff.prompt} label="Copy prompt" />
            </div>
            <details>
              <summary>What to ask your tool</summary>
              <p>{detail.handoff.prompt}</p>
            </details>
            <p className="muted-note">
              Sign in and manage usage in the official tool. No embedded AI
              session is connected.
            </p>
          </details>

        </section>
        <section className="preview-panel">
          <div className="preview-tabs">
            <div role="tablist" aria-label="Project views" onKeyDown={(event) => {
              const views = ["preview", "source", "checks"] as const;
              const index = views.indexOf(tab);
              const next = event.key === "ArrowRight" ? views[(index + 1) % 3] : event.key === "ArrowLeft" ? views[(index + 2) % 3] : event.key === "Home" ? views[0] : event.key === "End" ? views[2] : null;
              if (next) { event.preventDefault(); setTab(next); document.getElementById(`tab-${next}`)?.focus(); }
            }}>
              {(["preview", "source", "checks"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  id={`tab-${t}`}
                  aria-controls="project-view"
                  tabIndex={tab === t ? 0 : -1}
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                >
                  {t === "preview" ? (
                    <Monitor size={15} />
                  ) : t === "source" ? (
                    <Code2 size={15} />
                  ) : (
                    <CheckCheck size={15} />
                  )}{" "}
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <span className={"runtime-dot " + detail.runtime.status}>
              {detail.runtime.status === "running"
                ? "Live locally"
                : detail.runtime.status === "starting"
                  ? "Starting"
                  : detail.runtime.status === "failed"
                    ? "Preview failed"
                    : "Preview stopped"}
            </span>
          </div>
          <div id="project-view" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "preview" ? (
            <>
              <div className="browser-bar">
                <div className="traffic">
                  <i />
                  <i />
                  <i />
                </div>
                <span>{detail.runtime.url || "Your local preview"}</span>
                <button
                  title="Refresh preview"
                  aria-label="Refresh preview"
                  disabled={!detail.runtime.url}
                  onClick={() => setFrameKey((k) => k + 1)}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  className="device-button"
                  aria-label={device === "desktop" ? "Switch to mobile preview" : "Switch to desktop preview"}
                  aria-pressed={device === "mobile"}
                  onClick={() =>
                    setDevice((d) => (d === "desktop" ? "mobile" : "desktop"))
                  }
                >
                  {device === "desktop" ? <Monitor size={14} /> : <Smartphone size={14} />}{device === "desktop" ? "Desktop" : "Mobile"}
                </button>
              </div>
              <div className={"preview-canvas " + device}>
                {detail.runtime.status === "running" && detail.runtime.url ? (
                  <iframe
                    key={frameKey}
                    title="Project preview"
                    src={detail.runtime.url}
                    sandbox="allow-scripts allow-same-origin allow-forms"
                  />
                ) : (
                  <div className={"preview-empty " + (previewFailed ? "is-failed" : "")}>
                    <div className="preview-emblem">
                      {previewStarting || operation === "install" ? <LoaderCircle className="spin" size={32} /> : previewFailed ? <AlertTriangle size={32} /> : <Layers2 size={32} />}
                    </div>
                    <span className="eyebrow">{previewFailed ? "PREVIEW NEEDS ATTENTION" : previewStarting ? "STARTING LOCAL SERVER" : operation === "install" ? "PREPARING YOUR PROJECT" : "THE STAGE IS YOURS"}</span>
                    <h2>
                      {previewFailed ? "Let’s get you back on track." : previewStarting ? "A moment before the reveal." : operation === "install" ? "Good things take a moment." : "A home for your next idea."}
                    </h2>
                    <p>
                      {previewFailed ? "The local server stopped. Open the output below, fix the reported issue in your coding tool, then start preview again." : previewStarting ? "Waiting for your actual app to start. Your source will appear here as soon as it’s ready." : operation === "install"
                        ? "Installing the locked dependencies. This can take a moment on the first run."
                        : !detail.trusted
                          ? "Trust this project, install its dependencies, then bring your starter to life."
                          : installed
                            ? "Start the local preview to see your actual source. Edits from your coding tool appear here."
                            : "Install the locked dependencies, then start your local preview."}
                    </p>
                    {previewFailed && <details className="preview-error-log" open><summary>Preview output</summary><pre>{detail.runtime.log || "No server output was returned. Try starting preview again."}</pre></details>}
                    <div className="preview-chips">
                      <span>Local preview</span>
                      <span>Real source</span>
                      <span>Yours, entirely</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="preview-foot">
                <span>
                  <Folder size={13} />{" "}
                  {p.imported
                    ? "Your imported source"
                    : "Starter preview · Implement your brief in your coding tool"}
                </span>
                {detail.runtime.status === "running" && (
                  <button
                    disabled={disabled}
                    onClick={() => void action("stop")}
                  >
                    <Square size={11} /> Stop preview
                  </button>
                )}
              </div>
            </>
          ) : tab === "source" ? (
            <div className="source-view">
              <form className="flow-form" onSubmit={e=>{e.preventDefault();void restore(false);}}>
                <h3>Protected source restore</h3>
                <p>Choose a local commit from the history and explicit file paths. Native Git restores only those working files; the index stays unchanged. Source restore does not undo databases, deployments or external effects. Opening a restore review requires fresh verification, even if you cancel. Keep external editors idle during apply.</p>
                <label>Local target commit or tree<input aria-label="Restore target" required maxLength={200} value={restoreTarget} onChange={e=>{setRestoreTarget(e.target.value);setRestorePreview(null);setRestoreReviewed(false);}}/></label>
                <label>Source files · one relative file per line<textarea aria-label="Restore paths" required value={restorePaths} onChange={e=>{setRestorePaths(e.target.value);setRestorePreview(null);setRestoreReviewed(false);}}/></label>
                <button className="button" disabled={disabled||!detail.trusted}>Preview source restore</button>
                {restorePreview&&<div data-testid="restore-preview"><p>WORKTREE ONLY · target {restorePreview.targetTreeOrCommit}</p><ul>{restorePreview.paths.map(f=><li key={f.path}><code>{f.path}</code> · {f.action} · index {f.indexState?.oid.slice(0,12)||'absent'} · current {f.worktreeState.kind}</li>)}</ul>{restorePreview.blockedReasons.map(r=><p key={r} role="alert">{r}</p>)}<label className="check"><input type="checkbox" checked={restoreReviewed} onChange={e=>setRestoreReviewed(e.target.checked)}/> I reviewed these exact paths and permit replacing or deleting their working copies. External writers are idle.</label><button className="button danger" type="button" disabled={disabled||!restoreReviewed||restorePreview.blockedReasons.length>0} onClick={()=>void restore(true)}>Apply reviewed source restore</button></div>}
                {p.restore&&<div data-testid="restore-status"><strong>{p.restore.outcome} · {p.restore.verificationRequired?'Fresh verification required':'Verified by run '+p.restore.verificationRunId}</strong><pre>{p.restore.postStatus?.replaceAll('\0','\n')}</pre><button className="button" type="button" onClick={()=>setTab('checks')}>Continue to verification</button></div>}
              </form>
              <div className="source-heading">
                <FolderOpen size={26} />
                <div>
                  <h2>Your source. No exit required.</h2>
                  <p>
                    This folder already is your export. Copy it or use ordinary
                    Git.
                  </p>
                </div>
              </div>
              <div className="path-box">
                <code>{detail.path}</code>
                <CopyButton value={detail.path} label="Copy folder path" />
              </div>
              <p className="muted-note">
                For a portable source copy, keep source, configuration and
                package-lock.json. Exclude node_modules, dist and private .env
                files. No {DISPLAY_NAMES.umbrella} runtime is needed.
              </p>
              <div className="file-list">
                {detail.files.map((f) => (
                  <div key={f}>
                    {f.endsWith("/") ? (
                      <Folder size={15} />
                    ) : (
                      <FileCode2 size={15} />
                    )}
                    <span>{f}</span>
                  </div>
                ))}
              </div>
              <div className="git-heading">
                <GitBranch size={16} />
                <strong>{detail.git.branch}</strong>
                <button
                  className="button small"
                  disabled={disabled}
                  onClick={() => void load().catch((e) => setError(e.message))}
                >
                  <RefreshCw size={13} /> Refresh Git
                </button>
              </div>
              <pre>{detail.git.files}</pre>
              <h3>Recent commits</h3>
              <pre>{detail.git.history}</pre>
              <p className="muted-note">
                Commit and push from your coding tool. {DISPLAY_NAMES.umbrella} never resets,
                merges, or publishes your repository.
              </p>
            </div>
          ) : (
            <div className="checks-view">
              <div className="source-heading">
                <ShieldCheck size={26} />
                <div>
                  <h2>Know what actually works.</h2>
                  <p>
                    Real commands, real exit codes. Rerun after source changes.
                  </p>
                </div>
              </div>
              <p className="verification-note" data-verification-state={detail.verificationState} data-testid="verification-state">{detail.verificationState} · {p.verification?.id || "No source-bound run"}. {detail.identityError || "Old passes are historical. Current pass still requires human acceptance review."}</p>
              {p.restore?.verificationRequired&&<p role="status">Restore review requires a new verification run. Start this project’s preview, then run checks. Prior receipts remain historical.</p>}
              <form className="flow-form" onSubmit={async(e)=>{e.preventDefault();setPending("Saving flow");setError("");try{await api("/projects/"+id+"/flow",{method:"PUT",body:JSON.stringify({name:flowName,testPath:flowPath,outcome:flowOutcome,preserve:flowPreserve,width:1280,height:800})});await load();setNotice("Critical flow saved. Run checks against the current source.");}catch(e){setError((e as Error).message);}finally{setPending("");}}}>
                <h3>One critical user flow</h3><p>Keep an ordinary Playwright test in your owned project. It must assert the user outcome, beyond loading the page. Install @playwright/test and Chromium in that project using your official tool. For capped browser event diagnostics, copy the documented ordinary fixture from flow-example/diagnostics.ts. No private response bodies or traces are collected.</p>
                <label>Flow name<input aria-label="Flow name" required maxLength={100} value={flowName} onChange={e=>setFlowName(e.target.value)}/></label>
                <label>Playwright test path<input aria-label="Playwright test path" required value={flowPath} onChange={e=>setFlowPath(e.target.value)}/></label>
                <label>Requested user outcome<textarea aria-label="Requested user outcome" required minLength={10} maxLength={1000} value={flowOutcome} onChange={e=>setFlowOutcome(e.target.value)}/></label>
                <label>Preserve areas<textarea aria-label="Preserve areas" maxLength={1000} value={flowPreserve} onChange={e=>setFlowPreserve(e.target.value)}/></label>
                <button className="button primary" disabled={disabled}>Save critical flow</button><p>Chromium · 1280 × 800. Start this project's preview, then Run checks. Selected flow: {p.flow?.name||"None"}.</p>
              </form>
              {p.verification?.checks.flow && <details className="check-row" open><summary>Critical flow · {p.verification.checks.flow.status}</summary><pre>{p.verification.checks.flow.log}</pre><p>{p.verification.diagnostics.join("; ")}</p></details>}
              {p.verification?.packet && <details className="check-row" open><summary>Repair packet · review before official-tool handoff</summary><pre>{p.verification.packet}</pre><a download={"repair-"+p.verification.id+".json"} href={"data:application/json;charset=utf-8,"+encodeURIComponent(p.verification.packet)}>Download repair packet</a><CopyButton value={p.verification.packet} label="Copy repair packet"/></details>}
              {!!p.verificationHistory?.length && <details><summary>Historical verification runs</summary>{p.verificationHistory.map(r=><p key={r.id}>{r.startedAt} · {r.status} · {r.id} (historical)</p>)}</details>}
              {(["install", "typecheck", "build", "test"] as const).map(
                (key) => {
                  const result = key==="install" ? p.checks?.install : currentChecks?.[key];
                  return (
                    <details
                      className={"check-row " + (result?.status || "")}
                      key={`${key}-${result?.at || "idle"}`}
                      open={result?.status === "failed"}
                    >
                      <summary>
                        <span className="check-symbol">
                          {result?.status === "passed" ? (
                            <Check size={17} />
                          ) : result?.status === "failed" ? (
                            <X size={17} />
                          ) : (
                            <Circle size={14} />
                          )}
                        </span>
                        <span>
                          <strong>
                            {key === "install"
                              ? "Dependencies"
                              : key === "test"
                                ? "Project tests"
                                : key === "typecheck"
                                  ? "Typecheck"
                                  : "Production build"}
                          </strong>
                          <small>
                            {result
                              ? `Last run · ${new Date(result.at).toLocaleString()}`
                              : "Not run yet"}
                          </small>
                        </span>
                        <span className="check-status">
                          {result?.status || "Not run"}
                        </span>
                        <ChevronRight size={14} />
                      </summary>
                      <pre>
                        {result?.log || "Run this check to see actual output."}
                      </pre>
                    </details>
                  );
                },
              )}
              <div className="runtime-log">
                <h3>
                  <Terminal size={16} /> Preview output
                </h3>
                <pre>
                  {detail.runtime.log || "No preview output in this session."}
                </pre>
              </div>
            </div>
          )}
          </div>
        </section>
      </div>
      <footer className="workbench-footer">
        <span>
          <GitBranch size={13} /> {detail.git.branch}
        </span>
        <span>
          <ArrowDownToLine size={13} /> Saved to your filesystem
        </span>
        <span>NO MODEL CREDITS · NO SOURCE LOCK-IN</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </React.StrictMode>,
);
