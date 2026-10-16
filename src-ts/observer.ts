import type { Configuration } from "./configuration.ts";
import { branch } from "./configuration.ts";
import { Journal, type PreparedAction } from "./journal.ts";
import type { Source } from "./sources.ts";
import { publishFeed } from "./feed.ts";

export async function observeSource(
  configuration: Configuration,
  source: Source,
  journal: Journal,
  actions: PreparedAction[],
) {
  let failed = false;
  try {
    const commit = await source.readHead();
    const event = journal.observe(
      configuration.source,
      branch(configuration.source),
      commit,
      actions,
    );
    console.log(
      JSON.stringify({
        event: "branch-head-observed",
        commit_uri: commit,
        new_event: !!event,
        event_id: event?.id ?? null,
      }),
    );
  } catch {
    failed = true;
    journal.health("error");
  }
  if (configuration.feed) {
    try {
      const value = journal.view(
        branch(configuration.source),
        configuration.observation.interval_seconds,
      );
      publishFeed(configuration.feed.path, value);
      console.log(
        JSON.stringify({
          event: "activity-feed-published",
          status: value.status,
          branch_uri: value.branch_uri,
          latest_commit_uri: value.latest_commit_uri,
          retained_events: value.events.length,
        }),
      );
    } catch {
      failed = true;
      console.log(JSON.stringify({ event: "feed-publication-failed" }));
    }
  }
  return failed ? 2 : 0;
}
