export function approveOperation(mode, request, ask) {
  if (mode === "full" || mode === "assist" && request.risk === "routine") return true;
  return ask(request);
}
