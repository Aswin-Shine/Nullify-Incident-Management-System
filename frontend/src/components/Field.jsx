import { useId } from 'react';

// A label wired to its control by id. `children` is a render prop that receives the id.
export const Field = ({ label, children }) => {
  const id = useId();
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
};
