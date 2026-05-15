interface Props {
  onClose: () => void;
  onConfirm: () => void;
  hash: string;
}

export default function UnverifiedDownloadModal({ onClose, onConfirm }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--space-4)', fontSize: 'var(--text-xl)' }}>
          ⚠ Unverified Output
        </h2>
        <p style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--space-6)', lineHeight: 1.7 }}>
          These tests were generated but could not be verified against the target URL.
          They may contain incorrect selectors or missing assertions.
          <strong style={{ color: 'var(--color-text)' }}> Review carefully before adding to CI/CD.</strong>
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <button id="cancel-unverified-download" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button id="confirm-unverified-download" className="btn btn-danger" onClick={onConfirm}>
            ⬇ Download Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
