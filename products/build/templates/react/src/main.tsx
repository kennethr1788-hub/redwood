import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import data from "./project.json";
import { addTask, toggleTask } from "./tasks.mjs";
import "./style.css";
type Task = { id: string; title: string; done: boolean };
function Roadmap() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      const v: unknown = JSON.parse(
        localStorage.getItem("launchforge-tasks-v1") || "[]",
      );
      return Array.isArray(v) &&
        v.every(
          (t) =>
            typeof t.id === "string" &&
            typeof t.title === "string" &&
            typeof t.done === "boolean",
        )
        ? v
        : [];
    } catch {
      return [];
    }
  });
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  function save(next: Task[]) {
    setTasks(next);
    try {
      localStorage.setItem("launchforge-tasks-v1", JSON.stringify(next));
      setError("");
    } catch {
      setError(
        "Browser storage is unavailable; this board will reset on reload.",
      );
    }
  }
  return (
    <section>
      <span className="eyebrow">MAKE ROOM FOR PROGRESS</span>
      <h1>
        Small steps.
        <br />
        <em>Real momentum.</em>
      </h1>
      <p>
        A working starter board. Your coding tool can turn it into the product
        you imagined.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            save(addTask(tasks, title));
            setTitle("");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <input
          aria-label="New milestone"
          placeholder="What’s your next milestone?"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button>Add milestone</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div className="tasks">
        {tasks.length === 0 ? (
          <p>No milestones yet. Start with one small thing.</p>
        ) : (
          tasks.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => save(toggleTask(tasks, t.id))}
              />
              <span
                style={{ textDecoration: t.done ? "line-through" : "none" }}
              >
                {t.title}
              </span>
            </label>
          ))
        )}
      </div>
    </section>
  );
}
function App() {
  return (
    <BrowserRouter>
      <header>
        <NavLink className="brand" to="/">
          ◈ {data.name}
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/roadmap">Roadmap</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <section className="hero">
                <div>
                  <span className="eyebrow">
                    AN IDEA. A LITTLE COURAGE. YOUR NEXT CHAPTER.
                  </span>
                  <h1>
                    Good things
                    <br />
                    start <em>here.</em>
                  </h1>
                  <p>{data.brief}</p>
                  <NavLink className="cta" to="/roadmap">
                    Make your first move <span>↗</span>
                  </NavLink>
                  <small>React starter · Ready for your ideas</small>
                </div>
                <div className="art" aria-hidden="true">
                  <div className="orb" />
                  <div className="orbit" />
                  <span className="art-label">ROOM TO BECOME.</span>
                  <span className="art-number">01 — ∞</span>
                </div>
              </section>
            }
          />
          <Route path="/roadmap" element={<Roadmap />} />
          <Route
            path="/about"
            element={
              <section>
                <span className="eyebrow">BUILT TO BE YOURS</span>
                <h1>
                  Your idea.
                  <br />
                  <em>Your source.</em>
                </h1>
                <p>
                  {data.name} is an ordinary, independent web app. Edit it in
                  your favorite tool, keep it in Git, and host it wherever you
                  choose.
                </p>
                <div className="about-grid">
                  <article>
                    <b>01 / Own it</b>
                    <p>Every file is on your machine. No builder lock-in.</p>
                  </article>
                  <article>
                    <b>02 / Shape it</b>
                    <p>
                      Your brief is saved. Your existing coding tool takes it
                      from here.
                    </p>
                  </article>
                  <article>
                    <b>03 / Ship it</b>
                    <p>
                      Build, test, and choose your own hosting when you’re
                      ready.
                    </p>
                  </article>
                </div>
              </section>
            }
          />
          <Route
            path="*"
            element={
              <section>
                <h1>Page not found.</h1>
                <NavLink to="/">Back to the beginning</NavLink>
              </section>
            }
          />
        </Routes>
      </main>
      <footer>
        <span>{data.name}</span>
        <span>Made with a %LABEL_UMBRELLA% starter. Owned by you.</span>
      </footer>
    </BrowserRouter>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
