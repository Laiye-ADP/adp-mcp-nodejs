// Offline stdio integration: intercept every request, including unexpected ones.
globalThis.fetch = async (url, options) => {
  const target = new URL(String(url));
  const body = options.body === undefined ? undefined : JSON.parse(options.body);
  if (body?.app_id === "rejected-app" || body?.application_id === "rejected-app") {
    return Response.json({ code: "permission_denied", message: "Application access denied", data: null });
  }
  if (target.pathname.endsWith("/app-list")) {
    if (target.searchParams.get("owner_only") !== "true" || target.searchParams.get("app_type") !== "1") throw new Error("Unexpected discovery scope");
    const ai_function = Number(target.searchParams.get("ai_function") || 1425);
    return Response.json({ code: "success", data: { list: [{ id: `app-${ai_function}`, ai_function, output_schema: null }], range: { total: 1 } } });
  }
  if (target.pathname.endsWith("/app/runs/export")) {
    return Response.json({ code: "success", message: "saved report", data: {
      file_id: "export-file", download_url: "https://files.example.com/report", filename: "report.zip", file_size: 12,
      format: body.format ?? "excel", report_mode: body.report_mode ?? "merged",
      total_runs: 1, included_runs: 1, skipped_runs: 0, run_summaries: [{ run_id: "run-1", status: "succeeded" }],
      export_time: "2026-10-29T00:00:00Z", requested_body: body
    } });
  }
  const query = target.pathname.match(/\/app\/doc\/(recognize|extract|classify|extract\/routed)\/query\/task\/(.+)$/);
  if (query) {
    if (options.method !== "GET") throw new Error("Unexpected query method");
    const route = query[1];
    const task_id = decodeURIComponent(query[2]);
    const legacy = route === "recognize" || route === "extract";
    const status = legacy ? 4 : task_id.includes("partial") ? "partial_success" : task_id.includes("failed") ? "failed" : "success";
    return Response.json({ code: "success", data: { task_id, status, route,
      ...(route === "classify" ? { segments: [], unclassified_pages: [1] }
        : route === "recognize" ? { doc_recognize_result: [{ page: 1 }] }
        : { extraction_result: [{ app_id: "app-1425", object_values: [{ status: "success", extraction_result: [{ field_key: "retained" }] }] }] })
    } });
  }
  const task = target.pathname.match(/\/app\/doc\/(classify|extract\/routed)(\/create\/task)?$/);
  if (task) {
    if (options.method !== "POST" || body.wait !== undefined || body.file !== undefined) throw new Error("Unexpected task request");
    const routed = task[1] === "extract/routed";
    const status = task[2] ? "pending" : body.file_name === "partial.pdf" ? "partial_success" : body.file_name === "failed.pdf" ? "failed" : "success";
    return Response.json({ code: "success", message: "format warning retained", data: {
      task_id: "stdio-task", status, requested_body: body,
      ...(routed ? { extraction_result: body.file_name === "unclassified.pdf" ? [] : [
        { app_id: "app-1425", object_values: [
          { status: "success", extraction_result: [{ field_key: "contract_no", field_values: [{ field_value: "HT-1" }] }] },
          ...(status === "partial_success" ? [{ status: "failed", error: { code: "extract_failed", message: "failed instance" } }] : [])
        ] }
      ] } : { app_id: body.app_id, config_version: "v1", segments: [] }),
      unclassified_pages: [1]
    } });
  }
  throw new Error(`Unexpected offline request: ${target.pathname}`);
};
