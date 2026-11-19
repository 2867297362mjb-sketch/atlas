import { AlertTriangle } from "lucide-react";
import { EmptyState } from "@tryatlas/design";
import { FixWithAgentButton } from "@/features/ask-agent/components/ask-agent-button";

/**
 * What a pixi graph shows, over its canvas, when the renderer would not start.
 * Both graphs used to swallow an `init()` rejection, so a renderer that never
 * started read as a graph with nothing in it, and nobody saw why. `source`
 * names the graph to the agent the button asks.
 */
export function GraphInitError({ message, source }: { message: string; source: string }) {
  return (
    <div className="absolute inset-0">
      <EmptyState
        className="h-full"
        icon={AlertTriangle}
        title="Couldn't draw the graph"
        description={message}
        action={<FixWithAgentButton error={{ kind: "error", source, message }} />}
      />
    </div>
  );
}
