import { Button } from '@polycast/ui';

/**
 * Projects dashboard. Milestone 0 ships the empty state only; project listing arrives
 * with the first vertical slice (docs/implementation-plan.md M1).
 */
export default function ProjectsPage() {
  return (
    <section aria-labelledby="projects-heading">
      <h1 id="projects-heading">Projects</h1>
      <div className="card">
        <h2>No localizations yet</h2>
        <p className="muted">
          Upload an episode, confirm speakers and transcript, pick target languages, and get back
          localized audio or video with captions and a quality report.
        </p>
        <p className="muted">
          Supported sources: MP4, MOV, WebM video; WAV, FLAC, MP3, M4A audio. Audio-only sources
          skip lip sync.
        </p>
        <Button type="button" disabled aria-describedby="new-localization-note">
          New localization
        </Button>
        <p id="new-localization-note" className="muted">
          Upload and the five-step wizard are part of the first vertical slice and are not available
          in this build.
        </p>
      </div>
    </section>
  );
}
