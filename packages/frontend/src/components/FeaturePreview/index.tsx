import { useState } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import type { JobSummary } from '../../types';
import './FeaturePreview.css';

interface Props {
  summary: JobSummary;
}

// Fetch file content from backend (via download, then parse in memory)
// For simplicity, we show the file list and let users download for content.
export default function FeaturePreview({ summary }: Props) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const handleFileClick = async (filename: string) => {
    if (activeFile === filename) {
      setActiveFile(null);
      return;
    }
    // In a real implementation, we'd fetch individual file content.
    // For MVP, show placeholder.
    setActiveFile(filename);
    setLoading(true);
    setFileContent(`# ${filename}\n# Download the ZIP to view file contents.`);
    setLoading(false);
  };

  return (
    <div className="feature-preview card">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-muted">Generated Files</h3>
        <span className={`badge badge-${summary.verificationPassed ? 'completed' : 'failed'}`}>
          {summary.verificationPassed ? '✅ Verified' : '⚠ Unverified'}
        </span>
      </div>

      {/* Summary stats */}
      <div className="preview-stats">
        <div className="stat">
          <span className="stat-value">{summary.scenarioCount}</span>
          <span className="stat-label">scenarios</span>
        </div>
        {summary.unhealedScenarios > 0 && (
          <div className="stat stat-warning">
            <span className="stat-value">{summary.unhealedScenarios}</span>
            <span className="stat-label">unhealed</span>
          </div>
        )}
        <div className="stat">
          <span className="stat-value">{(summary.totalTokens / 1000).toFixed(1)}k</span>
          <span className="stat-label">tokens</span>
        </div>
        <div className="stat">
          <span className="stat-value">~${summary.estimatedCostUSD.toFixed(3)}</span>
          <span className="stat-label">est. cost</span>
        </div>
      </div>

      {/* File tree */}
      <div className="file-tree">
        <div className="tree-dir">
          <span className="tree-icon">📁</span>
          <span>features/</span>
        </div>
        {summary.featureFiles.map((f) => (
          <button
            key={f}
            className={`tree-file ${activeFile === f ? 'active' : ''}`}
            onClick={() => handleFileClick(f)}
          >
            <span className="tree-icon">🥒</span>
            <span>{f}</span>
          </button>
        ))}
        <div className="tree-dir">
          <span className="tree-icon">📁</span>
          <span>steps/</span>
        </div>
        <div className="tree-dir">
          <span className="tree-icon">📁</span>
          <span>support/</span>
        </div>
        <div className="tree-file static">
          <span className="tree-icon">⚙</span>
          <span>cucumber.js</span>
        </div>
        <div className="tree-file static">
          <span className="tree-icon">📋</span>
          <span>package.json</span>
          <span className="text-xs text-faint" style={{ marginLeft: 'auto' }}>exact-pinned</span>
        </div>
        <div className="tree-file static">
          <span className="tree-icon">🚀</span>
          <span>.github/workflows/e2e.yml</span>
        </div>
      </div>

      {/* Code preview */}
      {activeFile && (
        <div className="code-preview" style={{ marginTop: 'var(--space-4)' }}>
          {loading ? (
            <div className="text-sm text-faint" style={{ padding: 'var(--space-4)' }}>Loading…</div>
          ) : (
            <Highlight theme={themes.oneDark} code={fileContent} language="gherkin">
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre className={`${className} code-block`} style={{ ...style, margin: 0 }}>
                  {tokens.map((line, i) => (
                    <div key={i} {...getLineProps({ line })}>
                      <span className="line-num">{i + 1}</span>
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          )}
        </div>
      )}

      <div className="notice notice-warning" style={{ marginTop: 'var(--space-4)' }}>
        ⚠ AI-generated tests. Review carefully before adding to CI/CD.
      </div>
    </div>
  );
}
