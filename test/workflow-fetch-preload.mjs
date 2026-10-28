// Offline protocol test: every fetch is intercepted; no remote API is called.
globalThis.fetch = async (url, options) => {
  const target = new URL(String(url));
  if (target.pathname.endsWith("/app/run") || target.pathname.endsWith("/app/run/create/task")) {
    const body = JSON.parse(options.body);
    if (body.template_key !== undefined || body.wait !== undefined || body.release_version_id !== undefined || !body.application_id?.startsWith("wftp_app_")) {
      throw new Error("Unexpected direct-template request body");
    }
    return Response.json({ code: "success", data: {
      run_id: "stdio-run", status: target.pathname.endsWith("/app/run") ? "succeeded" : "pending",
      output: { requested_application_id: body.application_id }
    } });
  }
  if (!target.pathname.endsWith("/app/applications/create-from-template")) throw new Error("Unexpected offline-test request");
  const { template_key } = JSON.parse(options.body);
  return Response.json({ code: "success", message: "", data: {
    template_key, template_version: "1.0.0", application_id: "stdio-created-app", application_name: "Test app",
    release_version_id: "stdio-release", application_status: "published", can_run: true
  } });
};
