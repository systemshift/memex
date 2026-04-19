import { CircleCheck, CircleAlert, Loader2, Save, Sparkles, Box } from "../icons";

type Props = {
  mountPath: string;
  wordCount: number;
  saveState: "idle" | "saving" | "saved" | "error";
  model: string;
  apiKeyPresent: boolean;
  nodeCount: number | null;
};

/**
 * Bottom strip that surfaces the always-visible app state: current
 * mount, save progress, word count, which LLM is wired up. Visual
 * noise is kept low — this is reference info, not a control surface.
 */
export function StatusBar({
  mountPath,
  wordCount,
  saveState,
  model,
  apiKeyPresent,
  nodeCount,
}: Props) {
  return (
    <footer className="status-bar">
      <div className="status-item" title={mountPath}>
        <Box size={12} />
        <span className="status-path">{mountPath}</span>
        {nodeCount !== null && (
          <span className="status-muted">· {nodeCount} nodes</span>
        )}
      </div>

      <div className="status-spacer" />

      <div className="status-item" title="Word count in current note">
        {wordCount.toLocaleString()} words
      </div>

      <SaveIndicator state={saveState} />

      <div className="status-item" title={apiKeyPresent ? "OPENAI_API_KEY set" : "No OPENAI_API_KEY in env"}>
        <Sparkles size={12} />
        <span>{model}</span>
        {!apiKeyPresent && <span className="status-warn">no key</span>}
      </div>
    </footer>
  );
}

function SaveIndicator({ state }: { state: Props["saveState"] }) {
  switch (state) {
    case "saving":
      return (
        <div className="status-item save-saving">
          <Loader2 size={12} className="spin" /> saving
        </div>
      );
    case "saved":
      return (
        <div className="status-item save-saved">
          <CircleCheck size={12} /> saved
        </div>
      );
    case "error":
      return (
        <div className="status-item save-error">
          <CircleAlert size={12} /> save failed
        </div>
      );
    default:
      return (
        <div className="status-item status-muted">
          <Save size={12} /> ready
        </div>
      );
  }
}
