/**
 * project_patch multi-file content updates (tsk_94472aab item 1).
 *
 * /v1/deploy/patch already applies update_files, update_functions and
 * delete_files atomically in one call, anchored to base_release_id. The MCP
 * tool only accepted one file, so changing several meant either many chained
 * patches or a full project_deploy, which replaces the static tree and
 * deletes anything left out. This splits a `files` map exactly as the server
 * routes a single `path` (the shared isFunctionRoutePath rule), so a
 * multi-file patch keeps every unlisted file.
 */
import { isFunctionRoutePath } from '../../worker/src/utils/deploy-classify';

export function splitPatchFiles(files: Readonly<Record<string, string>>): {
  update_files?: Record<string, string>;
  update_functions?: Record<string, string>;
} {
  const updateFiles: Record<string, string> = {};
  const updateFunctions: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (isFunctionRoutePath(path)) updateFunctions[path] = content;
    else updateFiles[path] = content;
  }
  return {
    ...(Object.keys(updateFiles).length ? { update_files: updateFiles } : {}),
    ...(Object.keys(updateFunctions).length ? { update_functions: updateFunctions } : {}),
  };
}
