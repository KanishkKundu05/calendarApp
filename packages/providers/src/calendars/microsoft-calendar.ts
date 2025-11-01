import "server-only";

import { Client } from "@microsoft/microsoft-graph-client";
import type {
  Calendar as MicrosoftCalendar,
  ScheduleInformation,
} from "@microsoft/microsoft-graph-types";
import { Temporal } from "temporal-polyfill";

import type {
  CreateCalendarInput,
  CreateEventInput,
  UpdateCalendarInput,
  UpdateEventInput,
} from "@repo/schemas";

import type {
  Calendar,
  CalendarEvent,
  CalendarEventSyncItem,
  CalendarFreeBusy,
  CalendarProviderSyncOptions,
} from "../interfaces";
import type {
  CalendarProvider,
  ResponseToEventInput,
} from "../interfaces/providers";
import { ProviderError } from "../lib/provider-error";
import {
  calendarPath,
  parseMicrosoftCalendar,
} from "./microsoft-calendar/calendars";
import {
  eventResponseStatusPath,
  parseMicrosoftEvent,
  toMicrosoftDate,
  toMicrosoftEvent,
} from "./microsoft-calendar/events";
import { parseScheduleItem } from "./microsoft-calendar/freebusy";
import type { MicrosoftEvent } from "./microsoft-calendar/interfaces";

const MAX_EVENTS_PER_CALENDAR = 250;

interface MicrosoftCalendarProviderOptions {
  accessToken: string;
  accountId: string;
}

export class MicrosoftCalendarProvider implements CalendarProvider {
  public readonly providerId = "microsoft" as const;
  public readonly accountId: string;
  private graphClient: Client;

  constructor({ accessToken, accountId }: MicrosoftCalendarProviderOptions) {
    this.accountId = accountId;
    this.graphClient = Client.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => accessToken,
      },
    });
  }

  async calendars(): Promise<Calendar[]> {
    return this.withErrorHandler("calendars", async () => {
      // Microsoft Graph API does not work without $select due to a bug
      const response = await this.graphClient
        .api(
          "/me/calendars?$select=id,name,isDefaultCalendar,canEdit,hexColor,isRemovable,owner,calendarPermissions",
        )
        .get();

      return (response.value as MicrosoftCalendar[]).map((calendar) => ({
        ...parseMicrosoftCalendar({ calendar, accountId: this.accountId }),
      }));
    });
  }

  async calendar(calendarId: string): Promise<Calendar> {
    return this.withErrorHandler("calendar", async () => {
      const calendar = (await this.graphClient
        .api(calendarPath(calendarId))
        .select(
          "id,name,isDefaultCalendar,canEdit,hexColor,owner,calendarPermissions",
        )
        .get()) as MicrosoftCalendar;

      return parseMicrosoftCalendar({
        calendar,
        accountId: this.accountId,
      });
    });
  }

  async createCalendar(calendar: CreateCalendarInput): Promise<Calendar> {
    return this.withErrorHandler("createCalendar", async () => {
      const createdCalendar: MicrosoftCalendar = await this.graphClient
        .api("/me/calendars")
        .post({
          name: calendar.name,
        });

      return parseMicrosoftCalendar({
        calendar: createdCalendar,
        accountId: this.accountId,
      });
    });
  }

  async updateCalendar(
    calendarId: string,
    calendar: UpdateCalendarInput,
  ): Promise<Calendar> {
    return this.withErrorHandler("updateCalendar", async () => {
      const updatedCalendar: MicrosoftCalendar = await this.graphClient
        .api(calendarPath(calendarId))
        .patch(calendar);

      return parseMicrosoftCalendar({
        calendar: updatedCalendar,
        accountId: this.accountId,
      });
    });
  }

  async deleteCalendar(calendarId: string): Promise<void> {
    return this.withErrorHandler("deleteCalendar", async () => {
      await this.graphClient.api(calendarPath(calendarId)).delete();
    });
  }

  async events(
    calendar: Calendar,
    timeMin: Temporal.ZonedDateTime,
    timeMax: Temporal.ZonedDateTime,
    timeZone: string,
  ): Promise<{
    events: CalendarEvent[];
    recurringMasterEvents: CalendarEvent[];
  }> {
    return this.withErrorHandler("events", async () => {
      const startTime = timeMin.withTimeZone("UTC").toInstant().toString();
      const endTime = timeMax.withTimeZone("UTC").toInstant().toString();

      const response = await this.graphClient
        .api(`${calendarPath(calendar.id)}/events`)
        .header("Prefer", `outlook.timezone="${timeZone}"`)
        .filter(
          `start/dateTime ge '${startTime}' and end/dateTime le '${endTime}'`,
        )
        .orderby("start/dateTime")
        .top(MAX_EVENTS_PER_CALENDAR)
        .get();

      const events = (response.value as MicrosoftEvent[]).map(
        (event: MicrosoftEvent) =>
          parseMicrosoftEvent({ event, accountId: this.accountId, calendar }),
      );

      return { events, recurringMasterEvents: [] };
    });
  }

  async sync({
    calendar,
    initialSyncToken,
    timeMin,
    timeMax,
    timeZone,
  }: CalendarProviderSyncOptions): Promise<{
    changes: CalendarEventSyncItem[];
    syncToken: string | undefined;
    status: "incremental" | "full";
  }> {
    return this.withErrorHandler("sync", async () => {
      const startTime = timeMin?.withTimeZone("UTC").toInstant().toString();
      const endTime = timeMax?.withTimeZone("UTC").toInstant().toString();

      let syncToken: string | undefined;
      let pageToken: string | undefined = undefined;

      const baseUrl = new URL(
        `${calendarPath(calendar.id)}/calendarView/delta`,
      );

      if (startTime) {
        baseUrl.searchParams.set("startDateTime", startTime);
      }

      if (endTime) {
        baseUrl.searchParams.set("endDateTime", endTime);
      }

      const changes: CalendarEventSyncItem[] = [];

      do {
        const url: string = pageToken ?? initialSyncToken ?? baseUrl.toString();

        const response = await this.graphClient
          .api(url)
          .header("Prefer", `outlook.timezone="${timeZone}"`)
          .orderby("start/dateTime")
          .top(MAX_EVENTS_PER_CALENDAR)
          .get();

        // if (!initialSyncToken && !pageToken && startTime && endTime) {
        //   request.filter(
        //     `start/dateTime ge '${startTime}' and end/dateTime le '${endTime}'`,
        //   );
        // }

        for (const item of response.value as MicrosoftEvent[]) {
          if (!item?.id) {
            continue;
          }

          if (item["@removed"]) {
            changes.push({
              status: "deleted",
              event: {
                id: item.id,
                calendarId: calendar.id,
                accountId: this.accountId,
                providerId: this.providerId,
                providerAccountId: this.accountId,
              },
            });

            continue;
          }

          changes.push({
            status: "updated",
            event: parseMicrosoftEvent({
              event: item,
              accountId: this.accountId,
              calendar,
            }),
          });
        }

        pageToken = response["@odata.nextLink"];
        syncToken = response["@odata.deltaLink"];
      } while (pageToken);

      return {
        changes,
        syncToken,
        status: "incremental",
      };
    });
  }

  async event(
    calendar: Calendar,
    eventId: string,
    timeZone: string,
  ): Promise<CalendarEvent> {
    return this.withErrorHandler("event", async () => {
      const event: MicrosoftEvent = await this.graphClient
        .api(`${calendarPath(calendar.id)}/events/${eventId}`)
        .header("Prefer", `outlook.timezone="${timeZone}"`)
        .get();

      return parseMicrosoftEvent({
        event,
        accountId: this.accountId,
        calendar,
      });
    });
  }

  async createEvent(
    calendar: Calendar,
    event: CreateEventInput,
  ): Promise<CalendarEvent> {
    const startTime = Date.now();
    const eventData = {
      accountId: this.accountId,
      calendarId: calendar.id,
      calendarName: calendar.name,
      eventId: event.id,
      eventTitle: event.title,
      eventStart: event.start?.toString(),
      eventEnd: event.end?.toString(),
    };

    console.log("[MicrosoftCalendarProvider.createEvent] Starting", eventData);

    return this.withErrorHandler("createEvent", async () => {
      try {
        const microsoftEventData = toMicrosoftEvent(event);
        const apiPath = `${calendarPath(calendar.id)}/events`;
        
        console.log("[MicrosoftCalendarProvider.createEvent] Calling Microsoft Graph API", {
          ...eventData,
          apiPath,
          microsoftEventDataKeys: Object.keys(microsoftEventData),
        });

        const createdEvent: MicrosoftEvent = await this.graphClient
          .api(apiPath)
          .post(microsoftEventData);

        const duration = Date.now() - startTime;
        console.log("[MicrosoftCalendarProvider.createEvent] Microsoft Graph API call succeeded", {
          ...eventData,
          createdEventId: createdEvent.id,
          duration: `${duration}ms`,
        });

        return parseMicrosoftEvent({
          event: createdEvent,
          accountId: this.accountId,
          calendar,
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        
        // Log detailed error information
        const errorInfo = {
          ...eventData,
          duration: `${duration}ms`,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : undefined,
          errorStack: error instanceof Error ? error.stack : undefined,
        };

        // Check if it's a network error
        if (
          error instanceof Error &&
          (error.message.includes("fetch") ||
            error.message.includes("network") ||
            error.message.includes("NetworkError") ||
            error.message.includes("Failed to fetch") ||
            error.name === "NetworkError" ||
            error.name === "TypeError")
        ) {
          console.error("[MicrosoftCalendarProvider.createEvent] Network error", {
            ...errorInfo,
            errorType: "network",
          });
        } else {
          console.error("[MicrosoftCalendarProvider.createEvent] Error", errorInfo);
        }

        throw error;
      }
    }, eventData);
  }

  /**
   * Updates an existing event
   *
   * @param calendarId - The calendar identifier
   * @param eventId - The event identifier
   * @param event - Partial event data for updates using UpdateEventInput interface
   * @returns The updated transformed Event object
   */
  async updateEvent(
    calendar: Calendar,
    eventId: string,
    event: UpdateEventInput,
  ): Promise<CalendarEvent> {
    return this.withErrorHandler("updateEvent", async () => {
      // First, perform the regular event update
      const updatedEvent: MicrosoftEvent = await this.graphClient
        .api(`${calendarPath(calendar.id)}/events/${eventId}`)
        // TODO: Handle conflicts gracefully
        // .headers({
        //   ...(event.etag ? { "If-Match": event.etag } : {}),
        // })
        .patch(toMicrosoftEvent(event));

      // Then, handle response status update if present (Microsoft-specific approach)
      if (event.response && event.response.status !== "unknown") {
        await this.graphClient
          .api(
            `/me/events/${eventId}/${eventResponseStatusPath(event.response.status)}`,
          )
          .post({
            comment: event.response.comment,
            sendResponse: event.response.sendUpdate,
          });
      }

      return parseMicrosoftEvent({
        event: updatedEvent,
        accountId: this.accountId,
        calendar,
      });
    });
  }

  /**
   * Deletes an event from the calendar
   *
   * @param calendarId - The calendar identifier
   * @param eventId - The event identifier
   */
  async deleteEvent(
    calendarId: string,
    eventId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendUpdate: boolean = true,
  ): Promise<void> {
    await this.withErrorHandler("deleteEvent", async () => {
      await this.graphClient
        .api(`${calendarPath(calendarId)}/events/${eventId}`)
        .delete();
    });
  }

  async moveEvent(
    sourceCalendar: Calendar,
    destinationCalendar: Calendar,
    eventId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendUpdate: boolean = true,
  ): Promise<CalendarEvent> {
    return this.withErrorHandler("moveEvent", async () => {
      // Placeholder: Microsoft Graph does not have a direct move endpoint.
      // This could be implemented by creating a new event in destination and deleting the original,
      // preserving fields as needed.
      const event = await this.event(sourceCalendar, eventId, "UTC");

      return {
        ...event,
        calendarId: destinationCalendar.id,
        // Mark as readOnly to signal as placeholder behavior if needed by callers
        readOnly: event.readOnly,
      };
    });
  }

  async responseToEvent(
    calendarId: string,
    eventId: string,
    response: ResponseToEventInput,
  ): Promise<void> {
    await this.withErrorHandler("responseToEvent", async () => {
      if (response.status === "unknown") {
        return;
      }

      await this.graphClient
        .api(
          `/me/events/${eventId}/${eventResponseStatusPath(response.status)}`,
        )
        .post({ comment: response.comment, sendResponse: response.sendUpdate });
    });
  }

  async freeBusy(
    schedules: string[],
    timeMin: Temporal.ZonedDateTime,
    timeMax: Temporal.ZonedDateTime,
  ): Promise<CalendarFreeBusy[]> {
    return this.withErrorHandler("getSchedule", async () => {
      const body = {
        schedules,
        startTime: toMicrosoftDate({ value: timeMin }),
        endTime: toMicrosoftDate({ value: timeMax }),
      };

      const response = await this.graphClient
        .api("/me/calendar/getSchedule")
        .post(body);

      // TODO: Handle errors
      const data = response.value as ScheduleInformation[];

      return data.map((info) => ({
        scheduleId: info.scheduleId as string,
        busy: info.scheduleItems?.map(parseScheduleItem) ?? [],
      }));
    });
  }

  private async withErrorHandler<T>(
    operation: string,
    fn: () => Promise<T> | T,
    context?: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await Promise.resolve(fn());
    } catch (error: unknown) {
      const errorDetails = {
        operation,
        provider: "microsoft",
        accountId: this.accountId,
        context,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        errorStack: error instanceof Error ? error.stack : undefined,
      };

      // Check for network errors
      const isNetworkError =
        error instanceof Error &&
        (error.message.includes("fetch") ||
          error.message.includes("network") ||
          error.message.includes("NetworkError") ||
          error.message.includes("Failed to fetch") ||
          error.message.includes("timed out") ||
          error.message.includes("timeout") ||
          error.name === "NetworkError" ||
          error.name === "TypeError");

      if (isNetworkError) {
        console.error(`[MicrosoftCalendarProvider.withErrorHandler] Network error in ${operation}`, {
          ...errorDetails,
          errorType: "network",
          // Include additional error properties if available
          errorCause: error instanceof Error && "cause" in error ? error.cause : undefined,
        });
      } else {
        console.error(`[MicrosoftCalendarProvider.withErrorHandler] Failed to ${operation}:`, errorDetails);
      }

      throw new ProviderError(error as Error, operation, context);
    }
  }
}
