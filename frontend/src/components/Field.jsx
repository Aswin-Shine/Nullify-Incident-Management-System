import { useId } from 'react';

// A label wired to its control by id. `children` is a render prop that receives the id, and the id of the
// `hint` line (undefined without one) for the control's aria-describedby.
export const Field = ({ label, hint, children }) => {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      {children(id, hint ? hintId : undefined)}
      {hint && <p id={hintId} className="muted-sm field-hint">{hint}</p>}
    </div>
  );
};
