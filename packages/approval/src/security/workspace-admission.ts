import type {
  ProtectedRoot,
  WorkspaceAdmissionResult,
  WorkspacePathInfo,
  WorkspacePathProbe,
} from './types.js';

async function isInsideClosureRoot(
  probe: WorkspacePathProbe,
  roots: ProtectedRoot[],
  target: string,
): Promise<boolean> {
  for (const root of roots) {
    if (root.policy !== 'closure') continue;
    if (await probe.isSameOrDescendant(root.path, target)) return true;
  }
  return false;
}

/**
 * Deterministically admit a Workspace using the platform's canonical object
 * identities. Any inability to prove the boundary fails closed.
 */
export async function admitWorkspace(input: {
  target: string;
  protectedRoots: ProtectedRoot[];
  probe: WorkspacePathProbe;
}): Promise<WorkspaceAdmissionResult> {
  let inspected: WorkspacePathInfo;
  try {
    inspected = await input.probe.inspect(input.target);
  } catch {
    return {
      ok: false,
      ruleId: 'workspace.probe-failed',
      reason: '无法解析工作区的真实对象身份',
    };
  }

  if (inspected.exists !== false && !inspected.isDirectory) {
    return {
      ok: false,
      ruleId: 'workspace.not-directory',
      reason: 'Workspace 目标必须是目录',
    };
  }

  const closureRoots = input.protectedRoots.filter(
    (root) => root.policy === 'closure',
  );
  try {
    if (
      await isInsideClosureRoot(
        input.probe,
        closureRoots,
        inspected.canonicalPath,
      )
      || await isInsideClosureRoot(
        input.probe,
        closureRoots,
        inspected.nearestExistingAncestor,
      )
    ) {
      return {
        ok: false,
        ruleId: 'workspace.closure-root',
        reason: 'Workspace 位于受保护闭包根内',
      };
    }

    for (const root of input.protectedRoots) {
      if (
        root.policy === 'boundary'
        && await input.probe.isSameObject(root.path, inspected.canonicalPath)
      ) {
        return {
          ok: false,
          ruleId: 'workspace.boundary-root',
          reason: 'Workspace 不能是用户主目录、驱动器根或文件系统根本身',
        };
      }
    }

    for (const root of input.protectedRoots) {
      if (
        await input.probe.isSameOrDescendant(
          inspected.canonicalPath,
          root.path,
        )
      ) {
        return {
          ok: false,
          ruleId: 'workspace.contains-protected-root',
          reason: 'Workspace 包含受保护根对象',
        };
      }
    }
  } catch {
    return {
      ok: false,
      ruleId: 'workspace.probe-failed',
      reason: '无法验证 Workspace 的祖先链和对象身份',
    };
  }

  return {
    ok: true,
    canonicalPath: inspected.canonicalPath,
    identity: inspected.identity,
    nearestExistingAncestor: inspected.nearestExistingAncestor,
  };
}
