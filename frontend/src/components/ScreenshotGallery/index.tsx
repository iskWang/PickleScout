import { useState } from 'react';
import './ScreenshotGallery.css';

interface Props {
  screenshots: string[];
}

export default function ScreenshotGallery({ screenshots }: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  if (screenshots.length === 0) return null;

  return (
    <div className="screenshot-gallery card">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-muted">Screenshots</h3>
        <span className="text-xs text-faint">{screenshots.length}</span>
      </div>
      <div className="gallery-grid">
        {screenshots.map((url, i) => (
          <button
            key={i}
            className="gallery-thumb"
            onClick={() => setLightbox(url)}
            aria-label={`Screenshot ${i + 1}`}
          >
            <img src={url} alt={`Step ${i + 1}`} loading="lazy" />
          </button>
        ))}
      </div>

      {lightbox && (
        <div
          className="lightbox-overlay"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label="Screenshot lightbox"
        >
          <img src={lightbox} alt="Full screenshot" className="lightbox-img" />
          <button
            className="lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
