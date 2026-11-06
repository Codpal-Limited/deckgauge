'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * An employee's stored photo, or `children` (the initials avatar) when there is
 * none or it fails to load — a deleted upload must degrade to initials, never to
 * a broken-image icon. Decorative (`alt=""`): the name is always rendered beside it.
 */
export function EmployeePhoto({
  src,
  className,
  children,
}: {
  src: string | null | undefined;
  className: string;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <>{children}</>;
  return <img src={src} alt="" className={className} onError={() => setFailed(true)} />;
}
