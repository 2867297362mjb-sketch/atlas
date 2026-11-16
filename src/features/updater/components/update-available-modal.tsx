import { isWindows } from "@/lib/platform";
import { useUpdaterStore } from "../stores/updater-store";
import { restartToUpdate } from "../lib/restart-to-update";
import { UpdateAvailableModalView } from "./views/update-available-modal-view";

/** The update prompt's wiring. Mounted once at the app root. */
export function UpdateAvailableModal() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const error = useUpdaterStore((s) => s.error);
  const modalOpen = useUpdaterStore((s) => s.modalOpen);
  const { dismissModal } = useUpdaterStore((s) => s.actions);

  // Only the staged-ready, applying, and error phases have a modal.
  const state = phase === "ready" || phase === "applying" || phase === "error" ? phase : null;

  return (
    <UpdateAvailableModalView
      open={modalOpen && state !== null}
      state={state ?? "ready"}
      version={version}
      error={error}
      isWindows={isWindows}
      onRestart={restartToUpdate}
      onLater={dismissModal}
      // Esc and the backdrop do nothing while the restart is under way.
      onOpenChange={(o) => {
        if (!o && phase !== "applying") dismissModal();
      }}
    />
  );
}
