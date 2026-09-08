// Shared helper: resolve cmux context from inside a cmux terminal.
// Returns workspace name, surface ref, and workspace ref for routing.

const { execSync } = require('child_process');

const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';

/**
 * Get cmux routing info for the calling terminal.
 * Returns { workspaceName, surfaceRef, workspaceRef } or null if not in cmux.
 */
function getCmuxInfo() {
  if (!process.env.CMUX_SURFACE_ID) return null;
  try {
    const identifyOut = execSync(`${CMUX_BIN} identify`, { timeout: 2000 }).toString();
    const identifyJson = JSON.parse(identifyOut);
    const surfaceRef = identifyJson?.caller?.surface_ref;
    const workspaceRef = identifyJson?.caller?.workspace_ref;
    if (!surfaceRef || !workspaceRef) return null;

    // Resolve workspace name from list-workspaces
    let workspaceName = null;
    try {
      const listOut = execSync(`${CMUX_BIN} list-workspaces`, { timeout: 2000 }).toString();
      for (const line of listOut.split('\n')) {
        const match = line.match(/^\*?\s*(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/);
        if (match && match[1] === workspaceRef) {
          // Strip leading spinner/status chars like "⠂ " or "✳ "
          workspaceName = match[2].replace(/^[\u2800-\u28FF✳⠂]\s*/g, '').trim();
          break;
        }
      }
    } catch {}

    return {
      surfaceRef,
      workspaceRef,
      workspaceName: workspaceName || null,
    };
  } catch {}
  return null;
}

module.exports = { getCmuxInfo };
