/** Standard Server Action result: forms show `error` (and `fieldErrors`) or proceed on `ok`. */
export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export const fail = (error: string, fieldErrors?: Record<string, string[]>) =>
  ({ ok: false, error, ...(fieldErrors && { fieldErrors }) }) as const;
