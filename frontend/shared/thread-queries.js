export function threadListQueryKey({
  limit = null,
  scope = "default",
  surface,
}) {
  return [
    "thread-list",
    surface,
    scope,
    { limit },
  ];
}

export function threadTranscriptPageQueryKey({
  before = null,
  scope = "default",
  surface,
  threadId,
}) {
  return [
    "thread-transcript",
    surface,
    scope,
    threadId || "",
    before ?? null,
  ];
}

export function createThreadListQueryOptions({
  fetchThreads,
  limit = null,
  scope = "default",
  surface,
}) {
  return {
    queryKey: threadListQueryKey({ limit, scope, surface }),
    queryFn: () => fetchThreads({ limit }),
  };
}

export function createThreadTranscriptPageQueryOptions({
  before = null,
  fetchPage,
  scope = "default",
  surface,
  threadId,
}) {
  return {
    queryKey: threadTranscriptPageQueryKey({
      before,
      scope,
      surface,
      threadId,
    }),
    queryFn: () => fetchPage({
      before,
      threadId,
    }),
  };
}
