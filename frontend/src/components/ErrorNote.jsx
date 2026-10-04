// `onRetry` adds a "Try again" button for errors that a second attempt can clear (a failed load).
export const ErrorNote = ({ children, onRetry }) => (
  <div className="error-note" role="alert" data-retry={onRetry ? 'true' : undefined}>
    <span>{children}</span>
    {onRetry && <button type="button" className="btn-link error-retry" onClick={onRetry}>Try again</button>}
  </div>
);
