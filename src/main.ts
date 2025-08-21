const port = Number(Deno.env.get("PORT") ?? "8000");

Deno.serve({ port }, (_req: Request) => {
  return new Response("Reverie is running", { status: 200 });
});
