export function threadListQueryKey({
  filterValue = "",
  limit = null,
  scope = "default",
  surface,
}) {
  return [
    "thread-list",
    surface,
    scope,
    {
      cwd: normalizeFilterValue(filterValue),
      limit,
    },
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
  filterValue = "",
  limit = null,
  scope = "default",
  surface,
}) {
  const cwd = normalizeFilterValue(filterValue);
  return {
    queryKey: threadListQueryKey({
      filterValue: cwd,
      limit,
      scope,
      surface,
    }),
    queryFn: () => fetchThreads({
      filterValue: cwd,
      limit,
    }),
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

function normalizeFilterValue(value) {
  return String(value || "").trim();
}
