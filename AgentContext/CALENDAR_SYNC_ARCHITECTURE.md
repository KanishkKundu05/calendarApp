# Calendar Sync Architecture: TanStack Query + tRPC + Google Calendar API

This document details how TanStack Query and tRPC work together to keep the calendar UI synchronized with Google Calendar API in both directions, including optimistic updates for a seamless user experience.

## Table of Contents

1. [Syncing in Both Directions](#1-syncing-in-both-directions)
   - [a) Updates Made on Calendar → Google Calendar](#a-updates-made-on-calendar--google-calendar)
   - [b) Updates on Google Calendar → Calendar](#b-updates-on-google-calendar--calendar)
2. [Optimistic Loading](#2-optimistic-loading)

---

## 1. Syncing in Both Directions

### a) Updates Made on Calendar → Google Calendar

When users make changes in the calendar UI (create, update, or delete events), the changes flow through TanStack Form → tRPC mutations → Google Calendar API.

#### TanStack Form Integration

The event form uses **TanStack Form** (`@tanstack/react-form`) for form state management and validation:

**File:** `apps/web/src/components/event-form/utils/use-event-form.ts`

```typescript
const form = useAppForm({
  defaultValues,
  onSubmitMeta: defaultFormMeta,
  validators: {
    onBlur: formSchema,
    onSubmit: formSchema,
  },
  onSubmit: async ({ value, meta }) => {
    await saveAction(value, meta?.sendUpdate, () => {
      actorRef.send({ type: "CONFIRMED" });
      setIsPristine(true);
    });
  },
  listeners: {
    onBlur: async ({ formApi }) => {
      // Auto-save on blur if form is valid
      if (!formApi.state.isValid || requiresConfirmation(formApi.state.values)) {
        return;
      }
      await formApi.handleSubmit();
    },
    onChange: async ({ formApi }) => {
      if (formApi.state.isPristine) {
        return;
      }
      setIsPristine(false);
    },
  },
});
```

**Key Features:**
- **Auto-save on blur**: Form automatically saves when the user blurs a field, providing a seamless editing experience
- **Validation**: Uses Zod schemas (`formSchema`) for both onBlur and onSubmit validation
- **Form state management**: Integrates with Jotai atoms (`formAtom`, `isPristineAtom`) to track form state
- **Transformations**: Form values are transformed to `CalendarEvent` format via `toCalendarEvent()` before submission

#### Mutation Flow

**File:** `apps/web/src/components/calendar/flows/event-form/use-form-action.tsx`

The `useSaveAction` hook coordinates between create and update actions:

```typescript
export function useSaveAction() {
  const actorRef = EventFormStateContext.useActorRef();
  const createAction = useCreateAction();
  const updateAction = useUpdateAction();

  const save = React.useCallback(
    async (values: FormValues, notify?: boolean, onSuccess?: () => void) => {
      const event = toCalendarEvent({ values });

      if (values.type === "draft") {
        await createAction({ event, notify, onSuccess });
        return;
      }

      await updateAction({ event, notify, onSuccess });
      actorRef.send({ type: "SAVE", notify });
    },
    [actorRef, createAction, updateAction],
  );

  return save;
}
```

#### tRPC Mutations

**File:** `apps/web/src/components/calendar/hooks/use-event-mutations.ts`

The mutations use TanStack Query's `useMutation` hook with tRPC:

**Create Event Mutation:**
```typescript
export function useCreateEventMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { defaultTimeZone, queryKey } = useEventQueryParams();

  return useMutation(
    trpc.events.create.mutationOptions({
      onMutate: async (newEvent) => {
        // Cancel outgoing queries to prevent race conditions
        await queryClient.cancelQueries({ queryKey });

        // Snapshot previous state for rollback
        const previousEvents = queryClient.getQueryData(queryKey);

        // Optimistically update cache
        queryClient.setQueryData(queryKey, (prev) => {
          if (!prev) return undefined;
          
          const events = insertIntoSorted(
            prev.events || [], 
            newEvent, 
            (a) => isBefore(a.start, newEvent.start, { timeZone: defaultTimeZone })
          );

          return { ...prev, events };
        });

        return { previousEvents };
      },
      onError: (err, newEvent, context) => {
        // Rollback on error
        if (context?.previousEvents) {
          queryClient.setQueryData(queryKey, context.previousEvents);
        }
        toast.error(err.message);
      },
      onSettled: () => {
        // Invalidate to refetch from server
        queryClient.invalidateQueries({ queryKey });
      },
    }),
  );
}
```

**Update Event Mutation:**
```typescript
export function useUpdateEventMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { defaultTimeZone, queryKey } = useEventQueryParams();

  return useMutation(
    trpc.events.update.mutationOptions({
      onMutate: async ({ data, move }) => {
        await queryClient.cancelQueries({ queryKey });
        const previousEvents = queryClient.getQueryData(queryKey);

        queryClient.setQueryData(queryKey, (prev) => {
          if (!prev) return prev;

          // Remove old event and insert updated one
          const withoutEvent = prev.events.filter((e) => e.id !== data.id);
          const updatedEvent = {
            ...data,
            ...(move?.destination ? {
              accountId: move.destination.accountId,
              calendarId: move.destination.calendarId,
            } : {}),
          };

          const events = insertIntoSorted(withoutEvent, updatedEvent, (a) =>
            isBefore(a.start, data.start, { timeZone: defaultTimeZone })
          );

          return { ...prev, events };
        });

        return { previousEvents };
      },
      onError: (error, _, context) => {
        toast.error(error.message);
        if (context?.previousEvents) {
          queryClient.setQueryData(queryKey, context.previousEvents);
        }
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    }),
  );
}
```

**Delete Event Mutation:**
```typescript
export function useDeleteEventMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { queryKey } = useEventQueryParams();

  return useMutation(
    trpc.events.delete.mutationOptions({
      onMutate: async ({ eventId }) => {
        await queryClient.cancelQueries({ queryKey });
        const previousEvents = queryClient.getQueryData(queryKey);

        queryClient.setQueryData(queryKey, (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            events: prev.events.filter((event) => event.id !== eventId),
          };
        });

        return { previousEvents };
      },
      onError: (error, _, context) => {
        // Handle 410 (already deleted) gracefully
        if (/* isAlreadyDeleted */) {
          return; // Optimistic update already removed it
        }
        toast.error(error.message);
        if (context?.previousEvents) {
          queryClient.setQueryData(queryKey, context.previousEvents);
        }
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    }),
  );
}
```

#### tRPC API Endpoints

**File:** `packages/api/src/routers/events.ts`

The tRPC router exposes mutations that call the Google Calendar provider:

**Create Event:**
```typescript
create: calendarProcedure
  .input(createEventInputSchema)
  .mutation(async ({ ctx, input }) => {
    const provider = ctx.providers.find(
      ({ account }) => account.accountId === input.accountId,
    );

    if (!provider?.client) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Calendar client not found`,
      });
    }

    const calendars = await provider.client.calendars();
    const calendar = calendars.find((c) => c.id === input.calendarId);

    if (!calendar) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Calendar not found`,
      });
    }

    const event = await provider.client.createEvent(calendar, input);
    return { event };
  }),
```

**Update Event:**
```typescript
update: calendarProcedure
  .input(z.object({
    data: updateEventInputSchema,
    move: z.object({ /* ... */ }).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    const { data, move } = input;
    
    if (move) {
      // Handle moving event between calendars
      const sourceProvider = /* ... */;
      const destProvider = /* ... */;
      const event = await sourceProvider.client.moveEvent(/* ... */);
      return { event };
    } else {
      // Regular update
      const provider = /* ... */;
      const event = await provider.client.updateEvent(/* ... */);
      return { event };
    }
  }),
```

#### Google Calendar Provider

**File:** `packages/providers/src/calendars/google-calendar.ts`

The provider translates the application's event format to Google Calendar API format:

```typescript
async createEvent(
  calendar: Calendar,
  event: CreateEventInput,
): Promise<CalendarEvent> {
  return this.withErrorHandler("createEvent", async () => {
    const eventData = {
      ...toGoogleCalendarEvent(event),
      calendarId: calendar.id,
    };

    const createdEvent = await this.client.calendars.events.insert(
      eventData,
      { calendarId: calendar.id },
    );

    return parseGoogleCalendarEvent({
      calendar,
      accountId: this.accountId,
      event: createdEvent,
    });
  });
}

async updateEvent(
  calendar: Calendar,
  eventId: string,
  event: UpdateEventInput,
): Promise<CalendarEvent> {
  return this.withErrorHandler("updateEvent", async () => {
    const existingEvent = await this.client.calendars.events.retrieve(
      eventId,
      { calendarId: calendar.id },
    );

    let eventToUpdate = {
      ...existingEvent,
      calendarId: calendar.id,
      ...toGoogleCalendarEvent(event),
    };

    // Handle attendee response status updates
    if (event.response && event.response.status !== "unknown") {
      // Update attendee response status
      // ...
    }

    const updatedEvent = await this.client.calendars.events.update(
      eventId,
      eventToUpdate,
    );

    return parseGoogleCalendarEvent({
      calendar,
      accountId: this.accountId,
      event: updatedEvent,
    });
  });
}
```

#### Update Queue System

For efficient batching and handling of rapid updates, the app uses an **Update Queue** system built on XState:

**File:** `apps/web/src/components/calendar/flows/update-event/update-queue-provider.tsx`

```typescript
export function UpdateQueueProvider({ children }: UpdateQueueProviderProps) {
  const updateMutation = useUpdateEventMutation();
  const removeOptimisticAction = useSetAtom(removeOptimisticActionAtom);

  const updateEvent = React.useCallback(
    async (item: UpdateQueueItem) => {
      const prevEvent = await getEventById(item.event.id);

      if (!prevEvent) {
        if (item.event.type !== "draft") {
          throw new Error("Event not found");
        }
        item.onSuccess?.();
        return;
      }

      if (item.event.recurringEventId && item.scope === "series") {
        updateMutation.mutate(
          buildUpdateSeries(item.event, prevEvent, { sendUpdate: item.notify }),
          {
            onError: () => {
              removeOptimisticAction(item.optimisticId);
            },
            onSuccess: () => {
              item.onSuccess?.();
            },
          },
        );
        return;
      }

      updateMutation.mutate(
        buildUpdateEvent(item.event, prevEvent, { sendUpdate: item.notify }),
        {
          onError: () => {
            removeOptimisticAction(item.optimisticId);
          },
          onSuccess: () => {
            item.onSuccess?.();
          },
        },
      );
    },
    [updateMutation, removeOptimisticAction],
  );

  // ... XState machine setup
}
```

### b) Updates on Google Calendar → Calendar

When events are changed externally (via Google Calendar web UI, mobile app, or other clients), the app syncs those changes back to the calendar UI.

**Important Note:** This sync is **pull-based** (not push-based). There is **no webhook implementation** - changes made in Google Calendar are **not automatically reflected in real-time**. Instead, changes are only fetched when:
- The calendar page is reloaded
- The window regains focus (user switches back to the tab)
- The network reconnects
- The component remounts

This means there may be a delay between when changes occur in Google Calendar and when they appear in the app UI, until one of the above events triggers a refetch.

#### Sync Token Mechanism

Google Calendar uses **sync tokens** for incremental synchronization. The app stores sync tokens per calendar and uses them to fetch only changes since the last sync.

**File:** `packages/providers/src/calendars/google-calendar.ts`

```typescript
async sync({
  calendar,
  initialSyncToken,
  timeZone,
}: CalendarProviderSyncOptions): Promise<{
  changes: CalendarEventSyncItem[];
  syncToken: string | undefined;
  status: "incremental" | "full";
}> {
  const runSync = async (token: string | undefined) => {
    let currentSyncToken = token;
    let pageToken: string | undefined;
    const changes: CalendarEventSyncItem[] = [];

    do {
      const { items, nextSyncToken, nextPageToken } =
        await this.client.calendars.events.list(calendar.id, {
          singleEvents: true,
          showDeleted: true,
          maxResults: MAX_EVENTS_PER_CALENDAR,
          pageToken,
          syncToken: currentSyncToken,
        });

      if (nextSyncToken) {
        currentSyncToken = nextSyncToken;
      }

      pageToken = nextPageToken;

      if (!items) {
        continue;
      }

      for (const event of items) {
        if (event.status === "cancelled") {
          changes.push({
            status: "deleted",
            event: {
              id: event.id!,
              calendarId: calendar.id,
              accountId: this.accountId,
              providerId: this.providerId,
              providerAccountId: this.accountId,
            },
          });
          continue;
        }

        const parsedEvent = parseGoogleCalendarEvent({
          calendar,
          accountId: this.accountId,
          event,
          defaultTimeZone: timeZone,
        });

        changes.push({
          status: "updated",
          event: parsedEvent,
        });
      }
    } while (pageToken);

    // Handle recurring event instances
    const instances = changes
      .filter((e) => e.status !== "deleted" && e.event.recurringEventId)
      .map(({ event }) => (event as CalendarEvent).recurringEventId!);

    const recurringEvents = await this.recurringEvents(
      calendar,
      instances,
      timeZone,
    );

    changes.push(
      ...recurringEvents.map((event) => ({
        status: "updated" as const,
        event,
      })),
    );

    return {
      changes,
      syncToken: currentSyncToken,
    };
  };

  return this.withErrorHandler("sync", async () => {
    try {
      return await runSync(initialSyncToken);
    } catch (error: unknown) {
      // If sync token expired (410), perform full sync
      if (/* token expired */) {
        return {
          ...(await runSync(undefined)),
          status: "full" as const,
        };
      }
      throw error;
    }
  });
}
```

#### tRPC Sync Endpoint

**File:** `packages/api/src/routers/events.ts`

```typescript
sync: calendarProcedure
  .input(
    z.object({
      timeMin: zZonedDateTimeInstance.optional(),
      timeMax: zZonedDateTimeInstance.optional(),
      calendar: z.object({
        providerId: z.enum(["google", "microsoft"]),
        providerAccountId: z.string(),
        calendarId: z.string(),
        syncToken: z.string().optional(),
      }),
      timeZone: z.string().default("UTC"),
    }),
  )
  .query(async ({ ctx, input }) => {
    const provider = ctx.providers.find(
      ({ account }) => account.accountId === input.calendar.providerAccountId,
    );

    if (!provider?.client) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Calendar client not found`,
      });
    }

    const calendars = await provider.client.calendars();
    const calendar = calendars.find(
      (c) => c.id === input.calendar.calendarId,
    );

    if (!calendar) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Calendar not found`,
      });
    }

    const { changes, syncToken, status } = await provider.client.sync({
      calendar,
      initialSyncToken: input.calendar.syncToken,
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      timeZone: input.timeZone,
    });

    return {
      status,
      changes,
      syncToken,
    };
  }),
```

#### Events List Query

**File:** `apps/web/src/components/calendar/hooks/use-events.ts`

The main events query fetches events from all calendars:

```typescript
export function useEventsForDisplay() {
  const trpc = useTRPC();
  const { timeMin, timeMax, defaultTimeZone } = useEventQueryParams();

  const select = React.useCallback(
    (data: RouterOutputs["events"]["list"]) => {
      if (!data.events) {
        return {
          events: [],
          recurringMasterEvents: {},
        };
      }

      return {
        events: mapEventsToItems(data.events, defaultTimeZone),
        recurringMasterEvents: data.recurringMasterEvents,
      };
    },
    [defaultTimeZone],
  );

  return useQuery(
    trpc.events.list.queryOptions(
      { timeMin, timeMax, defaultTimeZone },
      {
        select,
      },
    ),
  );
}
```

#### Pull-Based Refetching (No Webhooks)

**File:** `apps/web/src/lib/trpc/query-client.tsx`

The QueryClient is configured to automatically refetch queries when:
- The window regains focus (`refetchOnWindowFocus: "always"`)
- The network reconnects (`refetchOnReconnect: "always"`)
- The component mounts (`refetchOnMount: "always"`)

```typescript
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
        refetchOnReconnect: "always",
        refetchOnWindowFocus: "always",
        refetchOnMount: "always",
      },
      // ... hydration/dehydration config
    },
    // ... query cache error handling
  });
}
```

**How It Works:**
- When a user switches back to the calendar tab or reconnects to the network, the `events.list` query automatically refetches
- This pull-based approach means external changes from Google Calendar are fetched and displayed, but **not in real-time**
- Changes made in Google Calendar will only appear when:
  1. The user manually refreshes the page
  2. The user switches away and back to the tab (window focus)
  3. The network disconnects and reconnects
  4. The component remounts for any reason

**Note:** There is **no webhook/push notification system** - this is purely a client-initiated polling mechanism. If a user has the calendar tab open and makes changes in Google Calendar, those changes won't appear until they switch tabs and come back, or refresh the page.

#### Events List Endpoint

**File:** `packages/api/src/routers/events.ts`

The `events.list` endpoint aggregates events from all calendars across all providers:

```typescript
list: calendarProcedure
  .input(
    z.object({
      calendarIds: z.array(z.string()).default([]),
      timeMin: zZonedDateTimeInstance,
      timeMax: zZonedDateTimeInstance,
      defaultTimeZone: z.string(),
    }),
  )
  .query(async ({ ctx, input }) => {
    const results = await Promise.all(
      ctx.providers.map(async ({ client, account }) => {
        const calendars = await client.calendars();

        const requestedCalendars =
          input.calendarIds.length === 0
            ? calendars
            : calendars.filter((cal) => input.calendarIds.includes(cal.id));

        const providerEvents = await Promise.all(
          requestedCalendars.map(async (calendar) => {
            const { events, recurringMasterEvents } = await client.events(
              calendar,
              input.timeMin,
              input.timeMax,
              input.defaultTimeZone,
            );

            const mapped = events.map((event) => ({
              ...event,
              calendarId: calendar.id,
              providerId: account.providerId,
              accountId: account.accountId,
              providerAccountId: account.accountId,
            }));

            return {
              events: mapped,
              recurringMasterEvents: Object.values(recurringMasterEvents),
            };
          }),
        );

        return providerEvents.flat();
      }),
    );

    // Aggregate and sort all events
    const allRecurringMasterEvents = results
      .flat()
      .map((e) => e.recurringMasterEvents)
      .flat();

    const recurringMasterEvents: Record<string, CalendarEvent> = R.mergeAll(
      allRecurringMasterEvents.map((e) => ({ [e.id]: e })),
    );

    const events: CalendarEvent[] = results
      .flat()
      .map((e) => e.events)
      .flat()
      .map((v) => [v, toInstant(v.start, { timeZone: "UTC" })] as const)
      .sort(([, i1], [, i2]) => Temporal.Instant.compare(i1, i2))
      .map(([v]) => v);

    return { events, recurringMasterEvents };
  }),
```

---

## 2. Optimistic Loading

Optimistic updates provide instant UI feedback while mutations are in flight, making the calendar feel responsive and seamless.

### Architecture Overview

The app uses a **two-layer optimistic update system**:

1. **TanStack Query optimistic updates**: Immediate cache updates during mutations
2. **Jotai atom-based optimistic actions**: Fine-grained control over optimistic state for complex scenarios

### TanStack Query Optimistic Updates

As shown in the mutation examples above, each mutation uses `onMutate` to immediately update the cache:

```typescript
onMutate: async (newEvent) => {
  // Cancel outgoing queries to prevent race conditions
  await queryClient.cancelQueries({ queryKey });
  
  // Snapshot previous state for rollback
  const previousEvents = queryClient.getQueryData(queryKey);
  
  // Optimistically update cache
  queryClient.setQueryData(queryKey, (prev) => {
    // Insert new event into sorted list
    // ...
  });
  
  return { previousEvents }; // Context for rollback
},
```

**Key Benefits:**
- Instant UI updates
- Automatic rollback on error
- Race condition prevention via `cancelQueries`

### Jotai Optimistic Actions

**File:** `apps/web/src/components/calendar/hooks/optimistic-actions.ts`

For more complex scenarios (like drafts, partial updates, and update queues), the app uses Jotai atoms:

```typescript
export type OptimisticAction =
  | { id?: string; type: "create"; eventId: string; event: CalendarEvent }
  | { id?: string; type: "update"; eventId: string; event: CalendarEvent }
  | { id?: string; type: "draft"; eventId: string; event: CalendarEvent }
  | { id?: string; type: "delete"; eventId: string };
```

**File:** `apps/web/src/components/calendar/flows/update-event/use-update-action.tsx`

```typescript
function useOptimisticUpdateAction() {
  const addOptimisticAction = useSetAtom(addOptimisticActionAtom);
  const removeDraftOptimisticActionsByEventId = useSetAtom(
    removeDraftOptimisticActionsByEventIdAtom,
  );

  return React.useCallback(
    async (
      optimisticId: string,
      event: CalendarEvent,
      type?: "draft" | "event",
    ) => {
      React.startTransition(() => {
        if (type === "draft") {
          removeDraftOptimisticActionsByEventId(event.id);
          addOptimisticAction({
            id: optimisticId,
            type: "draft",
            eventId: event.id,
            event,
          });
          return;
        }

        addOptimisticAction({
          id: optimisticId,
          type: "update",
          eventId: event.id,
          event,
        });
      });

      return optimisticId;
    },
    [addOptimisticAction, removeDraftOptimisticActionsByEventId],
  );
}
```

### Applying Optimistic Actions to UI

**File:** `apps/web/src/components/calendar-view.tsx`

Optimistic actions are applied to the event list before rendering:

```typescript
const events = React.useMemo(() => {
  const events = applyOptimisticActions({
    items: data?.events ?? [],
    timeZone: defaultTimeZone,
    optimisticActions,
  });

  // Apply filters, etc.
  return events;
}, [data?.events, defaultTimeZone, optimisticActions]);
```

**File:** `apps/web/src/components/calendar/hooks/apply-optimistic-actions.ts`

```typescript
export function applyOptimisticActions({
  items,
  timeZone,
  optimisticActions,
}: ApplyOptimisticActionsOptions) {
  // Filter out events that have optimistic actions (they'll be replaced)
  let optimisticItems = items.filter(
    (event) => optimisticActions[event.event.id] === undefined,
  );

  // Apply optimistic actions
  for (const action of Object.values(optimisticActions)) {
    if (action.type === "update") {
      const item = convertEventToItem(action.event, timeZone);
      optimisticItems = insertIntoSorted(optimisticItems, item, (a) =>
        isBefore(a.start, action.event.start, { timeZone }),
      );
    } else if (action.type === "delete") {
      optimisticItems = optimisticItems.filter(
        (event) => event.event.id !== action.eventId,
      );
    } else if (action.type === "create") {
      const item = convertEventToItem(action.event, timeZone);
      optimisticItems = insertIntoSorted(optimisticItems, item, (a) =>
        isBefore(a.start, action.event.start, { timeZone }),
      );
    } else if (action.type === "draft") {
      const item = convertEventToItem(action.event, timeZone);
      optimisticItems = insertIntoSorted(optimisticItems, item, (a) =>
        isBefore(a.start, action.event.start, { timeZone }),
      );
    }
  }

  return optimisticItems;
}
```

### Error Handling & Rollback

When mutations fail:

1. **TanStack Query rollback**: Automatically restores previous cache state via `onError`
2. **Optimistic action removal**: Jotai optimistic actions are removed in mutation `onError` callbacks
3. **User feedback**: Error toasts inform users of failures

**Example from Update Queue Provider:**
```typescript
updateMutation.mutate(
  buildUpdateEvent(item.event, prevEvent, { sendUpdate: item.notify }),
  {
    onError: () => {
      removeOptimisticAction(item.optimisticId);
    },
    onSuccess: () => {
      item.onSuccess?.();
    },
  },
);
```

### Benefits of This Approach

1. **Instant UI feedback**: Users see changes immediately
2. **Graceful degradation**: Errors are handled gracefully with rollback
3. **Race condition prevention**: `cancelQueries` prevents stale data
4. **Offline support**: Optimistic updates work even when offline (pending mutations queue)
5. **Complex scenarios**: Jotai atoms handle drafts, partial updates, and update queues

---

## Summary

The calendar sync architecture provides:

- **Bidirectional sync**: Changes flow both ways between the UI and Google Calendar
- **Pull-based sync (no webhooks)**: External changes from Google Calendar are fetched on page reload, window focus, or network reconnect - **not in real-time**
- **Optimistic updates**: Instant UI feedback with automatic rollback on errors
- **Form integration**: TanStack Form handles form state with auto-save on blur
- **Efficient syncing**: Sync tokens enable incremental syncs from Google Calendar (when refetches occur)
- **Automatic refetching**: Queries refetch on window focus/reconnect to catch external changes
- **Robust error handling**: Network errors, permission errors, and sync token expiration are handled gracefully

This architecture ensures the calendar UI stays synchronized with Google Calendar while providing a responsive, seamless user experience. Note that external changes (made in Google Calendar) are not reflected in real-time - they only appear when the calendar is reloaded or refetched.

