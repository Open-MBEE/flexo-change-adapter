import * as fs from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.origin === "https://adapter-source.invalid") {
    if (init?.method !== "GET" || !parsed.pathname.includes("/branches/"))
      throw Error("Unexpected synthetic source operation");
    return new Response(
      `<${url}> <https://mms.openmbee.org/rdf/ontology/commit> <${String(url).split("/branches/")[0]}/commits/${process.env.LOCAL_TEST_HEAD}> .`,
    );
  }
  const response = await original(url, init);
  const marker = process.env.LOCAL_TEST_LOST_RESPONSE;
  if (
    marker &&
    parsed.origin === "https://localhost:18443" &&
    parsed.pathname === "/job/adapter-smoke/buildWithParameters" &&
    init?.method === "POST" &&
    response.ok &&
    !fs.existsSync(marker)
  ) {
    fs.writeFileSync(
      marker,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          accepted_status: response.status,
          location: response.headers.get("location"),
          response_deliberately_discarded: true,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    throw Error("Deliberately discarded accepted Jenkins response");
  }
  return response;
};
