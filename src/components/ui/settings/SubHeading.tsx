import React from "react";
import { SUB_HEADING_CLASS } from "./settingsConstants";

/** Small uppercase label that groups related settings within a section. */
export const SubHeading = React.memo(function SubHeading({
  children,
}: { children: React.ReactNode }) {
  return (
    <p className={SUB_HEADING_CLASS} style={{ color: "var(--color-text-muted)" }}>
      {children}
    </p>
  );
});
