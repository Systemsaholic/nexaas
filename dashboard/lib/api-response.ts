export function ok<T>(data: T, status = 200) {
  return Response.json({ ok: true, data }, { status });
}

export function err(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

export function unauthorized() {
  return err("Unauthorized", 401);
}

export function notFound(what = "Resource") {
  return err(`${what} not found`, 404);
}
