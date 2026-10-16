import type { ValidationTarget } from "./configuration.ts";
export async function validationRunner(target: ValidationTarget) {
  if (target.type === "github") {
    const { GitHub } = await import("./github-api.ts"),
      { GitHubRunner } = await import("./github-runner.ts");
    return new GitHubRunner(
      new GitHub(
        target.owner,
        target.repository,
        process.env[target.token_env] ?? "",
      ),
    );
  }
  const { SharedValidationRunner } = await import("./shared-validation.ts");
  return new SharedValidationRunner(target);
}
