import { describe, it, expect, vi, type MockInstance } from "vitest";

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const calls: Array<{
    bin: string;
    args: ReadonlyArray<string>;
    opts: { env: NodeJS.ProcessEnv; stdio: [string, string, string] };
  }> = [];
  type FakeStream = {
    setEncoding: (encoding: string) => void;
    on: (event: string, listener: (chunk: string) => void) => void;
    emit: (event: string, chunk?: string) => boolean;
  };
  function makeStream(): FakeStream {
    const emitter = new EventEmitter() as unknown as FakeStream;
    emitter.setEncoding = () => undefined;
    return emitter;
  }
  function makeChild(): {
    stdout: FakeStream;
    stderr: FakeStream;
    stdin: FakeStream & { end: () => void };
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    emit: (event: string, ...args: unknown[]) => boolean;
  } {
    const emitter = new EventEmitter() as unknown as {
      stdout: FakeStream;
      stderr: FakeStream;
      stdin: FakeStream & { end: () => void };
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    (emitter as unknown as { stdout: FakeStream }).stdout = makeStream();
    (emitter as unknown as { stderr: FakeStream }).stderr = makeStream();
    const stdin = makeStream() as FakeStream & { end: () => void };
    stdin.end = () => undefined;
    (emitter as unknown as { stdin: FakeStream & { end: () => void } }).stdin =
      stdin;
    return emitter;
  }
  const spawn = vi.fn(
    (
      bin: string,
      args: ReadonlyArray<string>,
      opts: { env: NodeJS.ProcessEnv; stdio: [string, string, string] },
    ) => {
      calls.push({ bin, args, opts });
      const child = makeChild();
      const payload = JSON.stringify({ notebook: { id: "nb-1", title: "T" } });
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0, null);
      });
      return child;
    },
  );
  return { spawn, __calls: calls };
});

async function loadClient() {
  return import("./notebooklm-client.js");
}

interface CapturedCall {
  bin: string;
  args: ReadonlyArray<string>;
  opts: { env: NodeJS.ProcessEnv; stdio: [string, string, string] };
}

describe("default spawn wires through node:child_process.spawn", () => {
  it("forwards bin, args, env, and stdio to child_process.spawn", async () => {
    const cpMock = (await import("node:child_process")) as unknown as {
      spawn: MockInstance;
      __calls: CapturedCall[];
    };
    const clientMod = await loadClient();
    const client = clientMod.createNotebookLmClient();
    const result = await client.createNotebook({ title: "Hello" });
    expect(result.notebookExternalId).toBe("nb-1");
    expect(cpMock.__calls[0]?.bin).toBe("notebooklm");
    expect(cpMock.__calls[0]?.args).toEqual(["create", "Hello", "--json"]);
    expect(cpMock.__calls[0]?.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(cpMock.__calls[0]?.opts.env.PATH).toBe(process.env.PATH);
  });

  it("sets stdio to pipe stdin when writing a payload", async () => {
    const cpMock = (await import("node:child_process")) as unknown as {
      __calls: CapturedCall[];
    };
    const clientMod = await loadClient();
    const client = clientMod.createNotebookLmClient();
    await client.authCheck().catch(() => undefined);
    const call = cpMock.__calls.find((c) => c.args[0] === "auth");
    expect(call).toBeDefined();
    expect(call?.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});
