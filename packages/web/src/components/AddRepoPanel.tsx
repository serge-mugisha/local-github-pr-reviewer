import { useState } from "react";
import { api } from "../api.js";

interface AddRepoPanelProps {
  onAdded: () => void | Promise<void>;
}

export function AddRepoPanel({ onAdded }: AddRepoPanelProps) {
  const [newPath, setNewPath] = useState("");
  const [detect, setDetect] = useState<{ owner: string; name: string; localPath: string } | null>(
    null,
  );
  const [detectError, setDetectError] = useState<string>("");
  const [detecting, setDetecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);

  async function detectPath(path: string) {
    setDetecting(true);
    setDetectError("");
    setDetect(null);
    try {
      const d = await api.detectRepo(path.trim());
      setDetect(d);
    } catch (e) {
      setDetectError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  async function pickFolder() {
    setPicking(true);
    setDetectError("");
    try {
      const picked = await api.pickRepoFolder();
      if (!picked.localPath) return;
      setNewPath(picked.localPath);
      await detectPath(picked.localPath);
    } catch (e) {
      setDetectError((e as Error).message);
    } finally {
      setPicking(false);
    }
  }

  async function doDetect() {
    await detectPath(newPath);
  }

  async function doAdd() {
    setAdding(true);
    setDetectError("");
    try {
      await api.addRepo((detect?.localPath ?? newPath).trim());
      setNewPath("");
      setDetect(null);
      await onAdded();
    } catch (e) {
      setDetectError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="add-repo">
      <h3>Add a repo</h3>
      <div className="row add-repo-row">
        <input
          type="text"
          className="path-input"
          value={newPath}
          placeholder="/absolute/path/to/your/clone"
          onChange={(e) => {
            setNewPath(e.target.value);
            setDetect(null);
            setDetectError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doDetect();
          }}
        />
        <button className="btn" onClick={pickFolder} disabled={picking || detecting || adding}>
          {picking ? "Opening…" : "Choose folder"}
        </button>
        <button className="btn" onClick={doDetect} disabled={detecting || !newPath.trim()}>
          {detecting ? "Detecting…" : "Detect"}
        </button>
      </div>
      {detectError && <p className="warn small">{detectError}</p>}
      {detect && (
        <div className="detect-result">
          <p className="ok small">
            Detected{" "}
            <strong>
              {detect.owner}/{detect.name}
            </strong>{" "}
            at <code className="mono">{detect.localPath}</code>
          </p>
          <button className="btn primary" onClick={doAdd} disabled={adding}>
            {adding ? "Adding…" : "Add this repo"}
          </button>
        </div>
      )}
      <p className="muted small">
        Choose a local clone folder or paste its absolute path. Detection uses{" "}
        <code>gh repo view</code> inside that folder.
      </p>
    </div>
  );
}
