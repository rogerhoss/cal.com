import type { DestinationCalendar, Booking } from "@prisma/client";
import { cloneDeep, merge } from "lodash";
import { v5 as uuidv5 } from "uuid";
import type { z } from "zod";

import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import { FAKE_DAILY_CREDENTIAL } from "@calcom/app-store/dailyvideo/lib/VideoApiAdapter";
import { getEventLocationTypeFromApp } from "@calcom/app-store/locations";
import { MeetLocationType } from "@calcom/app-store/locations";
import getApps from "@calcom/app-store/utils";
import prisma from "@calcom/prisma";
import { createdEventSchema } from "@calcom/prisma/zod-utils";
import type { NewCalendarEventType } from "@calcom/types/Calendar";
import type { AdditionalInformation, CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload, CredentialWithAppName } from "@calcom/types/Credential";
import type { Event } from "@calcom/types/Event";
import type { EventResult } from "@calcom/types/EventManager";
import type { CreateUpdateResult, PartialBooking, PartialReference } from "@calcom/types/EventManager";

import { createEvent, updateEvent } from "./CalendarManager";
import { createMeeting, updateMeeting } from "./videoClient";

export const isDedicatedIntegration = (location: string): boolean => {
  return location !== MeetLocationType && location.includes("integrations:");
};

export const getLocationRequestFromIntegration = (location: string) => {
  const eventLocationType = getEventLocationTypeFromApp(location);
  if (eventLocationType) {
    const requestId = uuidv5(location, uuidv5.URL);

    return {
      conferenceData: {
        createRequest: {
          requestId: requestId,
        },
      },
      location,
    };
  }

  return null;
};

export const processLocation = (event: CalendarEvent): CalendarEvent => {
  // If location is set to an integration location
  // Build proper transforms for evt object
  // Extend evt object with those transformations

  // TODO: Rely on linkType:"dynamic" here. static links don't send their type. They send their URL directly.
  if (event.location?.includes("integration")) {
    const maybeLocationRequestObject = getLocationRequestFromIntegration(event.location);

    event = merge(event, maybeLocationRequestObject);
  }

  return event;
};

export type EventManagerUser = {
  credentials: CredentialPayload[];
  destinationCalendar: DestinationCalendar | null;
};

type createdEventSchema = z.infer<typeof createdEventSchema>;

export default class EventManager {
  calendarCredentials: CredentialWithAppName[];
  videoCredentials: CredentialWithAppName[];

  /**
   * Takes an array of credentials and initializes a new instance of the EventManager.
   *
   * @param user
   */
  constructor(user: EventManagerUser) {
    const appCredentials = getApps(user.credentials).flatMap((app) =>
      app.credentials.map((creds) => ({ ...creds, appName: app.name }))
    );
    // This includes all calendar-related apps, traditional calendars such as Google Calendar
    // (type google_calendar) and non-traditional calendars such as CRMs like Close.com
    // (type closecom_other_calendar)
    this.calendarCredentials = appCredentials.filter((cred) => cred.type.endsWith("_calendar"));
    this.videoCredentials = appCredentials.filter((cred) => cred.type.endsWith("_video"));
  }

  /**
   * Takes a CalendarEvent and creates all necessary integration entries for it.
   * When a video integration is chosen as the event's location, a video integration
   * event will be scheduled for it as well.
   *
   * @param event
   */
  public async create(event: CalendarEvent): Promise<CreateUpdateResult> {
    const evt = processLocation(event);
    // Fallback to cal video if no location is set
    if (!evt.location) evt["location"] = "integrations:daily";

    // Fallback to Cal Video if Google Meet is selected w/o a Google Cal
    if (evt.location === MeetLocationType && evt.destinationCalendar?.integration !== "google_calendar") {
      evt["location"] = "integrations:daily";
    }
    const isDedicated = evt.location ? isDedicatedIntegration(evt.location) : null;

    const results: Array<EventResult<Exclude<Event, AdditionalInformation>>> = [];

    // If and only if event type is a dedicated meeting, create a dedicated video meeting.
    if (isDedicated) {
      const result = await this.createVideoEvent(evt);

      if (result?.createdEvent) {
        evt.videoCallData = result.createdEvent;
        evt.location = result.originalEvent.location;
        result.type = result.createdEvent.type;
      }

      results.push(result);
    }

    // Some calendar libraries may edit the original event so let's clone it
    const clonedCalEvent = cloneDeep(event);
    // Create the calendar event with the proper video call data
    results.push(...(await this.createAllCalendarEvents(clonedCalEvent)));

    // Since the result can be a new calendar event or video event, we have to create a type guard
    // https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates
    const isCalendarResult = (
      result: (typeof results)[number]
    ): result is EventResult<NewCalendarEventType> => {
      return result.type.includes("_calendar");
    };

    const referencesToCreate = results.map((result) => {
      let createdEventObj: createdEventSchema | null = null;
      if (typeof result?.createdEvent === "string") {
        createdEventObj = createdEventSchema.parse(JSON.parse(result.createdEvent));
      }

      if (isCalendarResult(result)) {
        evt.iCalUID = result.iCalUID || undefined;
      }

      return {
        type: result.type,
        uid: createdEventObj ? createdEventObj.id : result.createdEvent?.id?.toString() ?? "",
        meetingId: createdEventObj ? createdEventObj.id : result.createdEvent?.id?.toString(),
        meetingPassword: createdEventObj ? createdEventObj.password : result.createdEvent?.password,
        meetingUrl: createdEventObj ? createdEventObj.onlineMeetingUrl : result.createdEvent?.url,
        externalCalendarId: evt.destinationCalendar?.externalId,
        credentialId: evt.destinationCalendar?.credentialId,
      };
    });

    return {
      results,
      referencesToCreate,
    };
  }

  public async updateLocation(event: CalendarEvent, booking: PartialBooking): Promise<CreateUpdateResult> {
    const evt = processLocation(event);
    const isDedicated = evt.location ? isDedicatedIntegration(evt.location) : null;

    const results: Array<EventResult<Exclude<Event, AdditionalInformation>>> = [];
    // If and only if event type is a dedicated meeting, create a dedicated video meeting.
    if (isDedicated) {
      const result = await this.createVideoEvent(evt);
      if (result.createdEvent) {
        evt.videoCallData = result.createdEvent;
      }

      results.push(result);
    }

    // Update the calendar event with the proper video call data
    const calendarReference = booking.references.find((reference) => reference.type.includes("_calendar"));
    if (calendarReference) {
      results.push(...(await this.updateAllCalendarEvents(evt, booking)));
    }

    const referencesToCreate = results.map((result) => {
      return {
        type: result.type,
        uid: result.createdEvent?.id?.toString() ?? "",
        meetingId: result.createdEvent?.id?.toString(),
        meetingPassword: result.createdEvent?.password,
        meetingUrl: result.createdEvent?.url,
        externalCalendarId: evt.destinationCalendar?.externalId,
        credentialId: evt.destinationCalendar?.credentialId,
      };
    });

    return {
      results,
      referencesToCreate,
    };
  }

  /**
   * Takes a calendarEvent and a rescheduleUid and updates the event that has the
   * given uid using the data delivered in the given CalendarEvent.
   *
   * @param event
   */
  public async reschedule(
    event: CalendarEvent,
    rescheduleUid: string,
    newBookingId?: number
  ): Promise<CreateUpdateResult> {
    const originalEvt = processLocation(event);
    const evt = cloneDeep(originalEvt);
    if (!rescheduleUid) {
      throw new Error("You called eventManager.update without an `rescheduleUid`. This should never happen.");
    }

    // Get details of existing booking.
    const booking = await prisma.booking.findFirst({
      where: {
        uid: rescheduleUid,
      },
      select: {
        id: true,
        userId: true,
        attendees: true,
        references: {
          // NOTE: id field removed from select as we don't require for deletingMany
          // but was giving error on recreate for reschedule, probably because promise.all() didn't finished
          select: {
            type: true,
            uid: true,
            meetingId: true,
            meetingPassword: true,
            meetingUrl: true,
            externalCalendarId: true,
            credentialId: true,
          },
        },
        destinationCalendar: true,
        payment: true,
        eventType: {
          select: {
            seatsPerTimeSlot: true,
            seatsShowAttendees: true,
          },
        },
      },
    });

    if (!booking) {
      throw new Error("booking not found");
    }

    const isDedicated = evt.location ? isDedicatedIntegration(evt.location) : null;
    const results: Array<EventResult<Event>> = [];
    // If and only if event type is a dedicated meeting, update the dedicated video meeting.
    if (isDedicated) {
      const result = await this.updateVideoEvent(evt, booking);
      const [updatedEvent] = Array.isArray(result.updatedEvent) ? result.updatedEvent : [result.updatedEvent];

      if (updatedEvent) {
        evt.videoCallData = updatedEvent;
        evt.location = updatedEvent.url;
      }
      results.push(result);
    }

    // There was a case that booking didn't had any reference and we don't want to throw error on function
    if (booking.references.find((reference) => reference.type.includes("_calendar"))) {
      // Update all calendar events.
      results.push(...(await this.updateAllCalendarEvents(evt, booking, newBookingId)));
    }

    const bookingPayment = booking?.payment;

    // Updating all payment to new
    if (bookingPayment && newBookingId) {
      const paymentIds = bookingPayment.map((payment) => payment.id);
      await prisma.payment.updateMany({
        where: {
          id: {
            in: paymentIds,
          },
        },
        data: {
          bookingId: newBookingId,
        },
      });
    }

    return {
      results,
      referencesToCreate: [...booking.references],
    };
  }

  public async updateCalendarAttendees(event: CalendarEvent, booking: PartialBooking) {
    if (booking.references.length === 0) {
      console.error("Tried to update references but there wasn't any.");
      return;
    }
    await this.updateAllCalendarEvents(event, booking);
  }

  /**
   * Creates event entries for all calendar integrations given in the credentials.
   * When noMail is true, no mails will be sent. This is used when the event is
   * a video meeting because then the mail containing the video credentials will be
   * more important than the mails created for these bare calendar events.
   *
   * When the optional uid is set, it will be used instead of the auto generated uid.
   *
   * @param event
   * @param noMail
   * @private
   */
  private async createAllCalendarEvents(event: CalendarEvent) {
    /** Can I use destinationCalendar here? */
    /* How can I link a DC to a cred? */

    let createdEvents: EventResult<NewCalendarEventType>[] = [];
    if (event.destinationCalendar) {
      if (event.destinationCalendar.credentialId) {
        const credential = this.calendarCredentials.find(
          (c) => c.id === event.destinationCalendar?.credentialId
        );

        if (credential) {
          const createdEvent = await createEvent(credential, event);
          if (createdEvent) {
            createdEvents.push(createdEvent);
          }
        }
      } else {
        const destinationCalendarCredentials = this.calendarCredentials.filter(
          (c) => c.type === event.destinationCalendar?.integration
        );
        createdEvents = createdEvents.concat(
          await Promise.all(destinationCalendarCredentials.map(async (c) => await createEvent(c, event)))
        );
      }
    } else {
      /**
       *  Not ideal but, if we don't find a destination calendar,
       * fallback to the first connected calendar
       */
      const [credential] = this.calendarCredentials.filter((cred) => cred.type === "calendar");
      if (credential) {
        const createdEvent = await createEvent(credential, event);
        if (createdEvent) {
          createdEvents.push(createdEvent);
        }
      }
    }

    // Taking care of non-traditional calendar integrations
    createdEvents = createdEvents.concat(
      await Promise.all(
        this.calendarCredentials
          .filter((cred) => cred.type.includes("other_calendar"))
          .map(async (cred) => await createEvent(cred, event))
      )
    );

    return createdEvents;
  }

  /**
   * Checks which video integration is needed for the event's location and returns
   * credentials for that - if existing.
   * @param event
   * @private
   */

  private getVideoCredential(event: CalendarEvent): CredentialWithAppName | undefined {
    if (!event.location) {
      return undefined;
    }

    /** @fixme potential bug since Google Meet are saved as `integrations:google:meet` and there are no `google:meet` type in our DB */
    const integrationName = event.location.replace("integrations:", "");

    let videoCredential = this.videoCredentials
      // Whenever a new video connection is added, latest credentials are added with the highest ID.
      // Because you can't rely on having them in the highest first order here, ensure this by sorting in DESC order
      .sort((a, b) => {
        return b.id - a.id;
      })
      .find((credential: CredentialPayload) => credential.type.includes(integrationName));

    /**
     * This might happen if someone tries to use a location with a missing credential, so we fallback to Cal Video.
     * @todo remove location from event types that has missing credentials
     * */
    if (!videoCredential) videoCredential = { ...FAKE_DAILY_CREDENTIAL, appName: "FAKE" };

    return videoCredential;
  }

  /**
   * Creates a video event entry for the selected integration location.
   *
   * When optional uid is set, it will be used instead of the auto generated uid.
   *
   * @param event
   * @private
   */
  private createVideoEvent(event: CalendarEvent) {
    const credential = this.getVideoCredential(event);

    if (credential) {
      return createMeeting(credential, event);
    } else {
      return Promise.reject(
        `No suitable credentials given for the requested integration name:${event.location}`
      );
    }
  }

  /**
   * Updates the event entries for all calendar integrations given in the credentials.
   * When noMail is true, no mails will be sent. This is used when the event is
   * a video meeting because then the mail containing the video credentials will be
   * more important than the mails created for these bare calendar events.
   *
   * @param event
   * @param booking
   * @private
   */
  private async updateAllCalendarEvents(
    event: CalendarEvent,
    booking: PartialBooking,
    newBookingId?: number
  ): Promise<Array<EventResult<NewCalendarEventType>>> {
    let calendarReference: PartialReference | undefined = undefined,
      credential;
    try {
      // If a newBookingId is given, update that calendar event
      let newBooking;
      if (newBookingId) {
        newBooking = await prisma.booking.findUnique({
          where: {
            id: newBookingId,
          },
          select: {
            references: true,
          },
        });
      }

      calendarReference = newBooking?.references.length
        ? newBooking.references.find((reference) => reference.type.includes("_calendar"))
        : booking.references.find((reference) => reference.type.includes("_calendar"));

      if (!calendarReference) {
        return [];
      }
      const { uid: bookingRefUid, externalCalendarId: bookingExternalCalendarId } = calendarReference;

      if (!bookingExternalCalendarId) {
        throw new Error("externalCalendarId");
      }

      let result = [];
      if (calendarReference.credentialId) {
        credential = this.calendarCredentials.filter(
          (credential) => credential.id === calendarReference?.credentialId
        )[0];
        result.push(updateEvent(credential, event, bookingRefUid, bookingExternalCalendarId));
      } else {
        const credentials = this.calendarCredentials.filter(
          (credential) => credential.type === calendarReference?.type
        );
        for (const credential of credentials) {
          result.push(updateEvent(credential, event, bookingRefUid, bookingExternalCalendarId));
        }
      }

      // If we are merging two calendar events we should delete the old calendar event
      if (newBookingId) {
        const oldCalendarEvent = booking.references.find((reference) => reference.type.includes("_calendar"));

        if (oldCalendarEvent?.credentialId) {
          const calendarCredential = await prisma.credential.findUnique({
            where: {
              id: oldCalendarEvent.credentialId,
            },
          });
          const calendar = getCalendar(calendarCredential);

          await calendar?.deleteEvent(oldCalendarEvent.uid, event, oldCalendarEvent.externalCalendarId);
        }
      }

      // Taking care of non-traditional calendar integrations
      result = result.concat(
        this.calendarCredentials
          .filter((cred) => cred.type.includes("other_calendar"))
          .map(async (cred) => {
            const calendarReference = booking.references.find((ref) => ref.type === cred.type);
            if (!calendarReference)
              if (!calendarReference) {
                return {
                  appName: cred.appName,
                  type: cred.type,
                  success: false,
                  uid: "",
                  originalEvent: event,
                };
              }
            const { externalCalendarId: bookingExternalCalendarId, meetingId: bookingRefUid } =
              calendarReference;
            return await updateEvent(cred, event, bookingRefUid ?? null, bookingExternalCalendarId ?? null);
          })
      );

      return Promise.all(result);
    } catch (error) {
      let message = `Tried to 'updateAllCalendarEvents' but there was no '{thing}' for '${credential?.type}', userId: '${credential?.userId}', bookingId: '${booking?.id}'`;
      if (error instanceof Error) {
        message = message.replace("{thing}", error.message);
      }
      console.error(message);
      return Promise.resolve([
        {
          appName: "none",
          type: calendarReference?.type || "calendar",
          success: false,
          uid: "",
          originalEvent: event,
        },
      ]);
    }
  }

  /**
   * Updates a single video event.
   *
   * @param event
   * @param booking
   * @private
   */
  private updateVideoEvent(event: CalendarEvent, booking: PartialBooking) {
    const credential = this.getVideoCredential(event);

    if (credential) {
      const bookingRef = booking ? booking.references.filter((ref) => ref.type === credential.type)[0] : null;
      return updateMeeting(credential, event, bookingRef);
    } else {
      return Promise.reject(
        `No suitable credentials given for the requested integration name:${event.location}`
      );
    }
  }

  /**
   * Update event to set a cancelled event placeholder on users calendar
   * remove if virtual calendar is already done and user availability its read from there
   * and not only in their calendars
   * @param event
   * @param booking
   * @public
   */
  public async updateAndSetCancelledPlaceholder(event: CalendarEvent, booking: PartialBooking) {
    await this.updateAllCalendarEvents(event, booking);
  }

  public async rescheduleBookingWithSeats(
    originalBooking: Booking,
    newTimeSlotBooking?: Booking,
    owner?: boolean
  ) {
    // Get originalBooking
    // If originalBooking has only one attendee we should do normal reschedule
    // Change current event attendees in everyone calendar
  }
}
