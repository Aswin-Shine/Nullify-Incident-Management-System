import { useState, useId } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fetchComments, fetchHistory, addComment, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { useToast } from '../context/toast';
import { ErrorNote } from './ErrorNote';
import { fmtStamp } from '../format';

// One line per history event, e.g. "alice changed status OPEN → INVESTIGATING".
function eventText(e) {
  const who = e.actor_username ?? 'System';
  switch (e.kind) {
    case 'created': return `${who} opened the incident (${e.to_value})`;
    case 'status': return `${who} changed status ${e.from_value} → ${e.to_value}`;
    case 'assigned': return e.to_value ? `${who} assigned to ${e.to_value}` : `${who} unassigned`;
    case 'rca_submitted': return `${who} submitted the RCA`;
    default: return `${who} ${e.kind}`;
  }
}

// The stamp is absolute (a timeline is read back later); the relative time is the tooltip.
const MAX_COMMENT = 4000;  // the backend limit
const COUNTER_FROM = 3500;  // the counter only shows when the limit is near
const ago = (iso) => formatDistanceToNow(new Date(iso), { addSuffix: true });
const Stamp = ({ iso }) => <span className="comment-time" title={ago(iso)}>{fmtStamp(iso)}</span>;

// Comments and history events, merged oldest first. `history` is the parent's query when it already loads the events
// (the incident detail does), so they are fetched once; without it this section loads them itself.
export function CommentsSection({ wiId, refreshTick, history: shared }) {
  const comments = useQuery(wiId, () => fetchComments(wiId), refreshTick);
  const own = useQuery(shared ? null : wiId, () => fetchHistory(wiId), refreshTick);
  const history = shared ?? own;
  const toast = useToast();
  const entries = [
    ...(comments.data ?? []).map(c => ({ ...c, type: 'comment' })),
    ...(history.data ?? []).map(e => ({ ...e, type: 'event' })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const loadError = comments.error || history.error;
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const counterId = useId();

  const post = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setPosting(true);
    try {
      await addComment(wiId, text);
      setText('');
      comments.reload();
      toast('Comment posted');
    } catch (err) {
      toast(errorMessage(err, 'Could not post the comment'), { kind: 'error' });
    } finally { setPosting(false); }
  };

  return (
    <div>
      <div className="timeline-head">
        <h2>Timeline</h2>
        <span className="count-chip">{entries.length}</span>
      </div>
      {loadError && <ErrorNote onRetry={() => { comments.reload(); history.reload(); }}>{errorMessage(loadError, 'Could not load the timeline')}</ErrorNote>}

      <div className="timeline">
        {entries.length > 0 && <div className="timeline-line" />}
        <div className="timeline-items">
          {entries.length === 0 && <p className="muted">No activity yet.</p>}
          {entries.map(c => c.type === 'event' ? (
            <div key={`e:${c.id}`} className="comment timeline-event">
              <div className="comment-dot event-dot" />
              <div className="event-line">
                <span className="event-text">{eventText(c)}</span>
                <Stamp iso={c.created_at} />
              </div>
            </div>
          ) : (
            <div key={`c:${c.id}`} className="comment">
              <div className="comment-dot" />
              <div className="comment-card">
                <div className="comment-head">
                  <span className="comment-author">{c.author_username}</span>
                  <Stamp iso={c.created_at} />
                </div>
                <p className="comment-body" dir="auto">{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <form className="composer" onSubmit={post}>
        <textarea
          name="comment"
          aria-label="Add a comment"
          placeholder="Add a comment… (Ctrl+Enter to post)"
          maxLength={MAX_COMMENT}
          aria-describedby={text.length > COUNTER_FROM ? counterId : undefined}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post(e); }}
        />
        <div className="composer-actions">
          {text.length > COUNTER_FROM && (
            <span id={counterId} className="composer-count">{text.length.toLocaleString()} / {MAX_COMMENT.toLocaleString()}</span>
          )}
          <button type="submit" className="btn btn-primary btn-pill" disabled={!text.trim() || posting}>
            {posting ? <span className="spinner" /> : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}
