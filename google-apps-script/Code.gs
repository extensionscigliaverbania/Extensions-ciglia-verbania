/**
 * Extensions Ciglia Verbania - Google Calendar bridge
 *
 * Pubblicazione: Web App, esegui come proprietario, accesso "Chiunque".
 * Proprietà script richieste:
 *   GOOGLE_BRIDGE_TOKEN = stesso token configurato in Supabase
 *   GOOGLE_CALENDAR_ID = ID del calendario di destinazione
 *
 * API POST JSON:
 *   { token, action:"upsert", bookingId, startsAt, endsAt, title, description }
 *   { token, action:"delete", bookingId }
 *   { token, action:"health" }
 *
 * upsert è idempotente: ripetere la stessa richiesta aggiorna l'evento
 * esistente invece di crearne uno duplicato.
 */

const CONFIG = Object.freeze({
  TIME_ZONE: "Europe/Rome",
  EVENT_ID_PREFIX: "EXTENSIONS_BOOKING_ID=",
  PROPERTY_PREFIX: "EXTENSIONS_EVENT_",
  MAX_TITLE_LENGTH: 250,
  MAX_DESCRIPTION_LENGTH: 8000,
  LOCK_TIMEOUT_MS: 20000
});

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const request = parseRequest_(e);
    const properties = PropertiesService.getScriptProperties();
    authorize_(request.token, properties);

    const action = String(request.action || "").toLowerCase();
    if (action === "health") {
      return json_({
        ok: true,
        service: "extensions-ciglia-calendar-bridge",
        timeZone: CONFIG.TIME_ZONE,
        calendarConfigured: Boolean(properties.getProperty("GOOGLE_CALENDAR_ID"))
      });
    }

    const bookingId = validateBookingId_(request.bookingId);
    const calendar = getCalendar_(properties);

    if (action === "delete") {
      lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
      try {
        deleteBookingEvent_(calendar, properties, bookingId);
      } finally {
        lock.releaseLock();
      }
      return json_({ ok: true, action: "delete", bookingId: bookingId });
    }

    if (action !== "upsert") {
      throw new Error("Azione non riconosciuta. Usa upsert, delete o health.");
    }

    // Accetta il formato ISO usato dal sito e, per compatibilità, i vecchi campi data/ora.
    const start = parseDate_(request.startsAt || combineLocalDateTime_(request, false), "startsAt");
    const end = parseDate_(request.endsAt || combineLocalDateTime_(request, true), "endsAt");
    if (start.getTime() >= end.getTime()) {
      throw new Error("L'orario di fine deve essere successivo all'inizio.");
    }

    const title = cleanText_(request.title || "Prenotazione Extensions Ciglia", CONFIG.MAX_TITLE_LENGTH);
    const description = buildDescription_(request.description, bookingId);

    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
    let event;
    try {
      event = upsertBookingEvent_(calendar, properties, bookingId, title, description, start, end);
    } finally {
      lock.releaseLock();
    }

    return json_({
      ok: true,
      action: "upsert",
      bookingId: bookingId,
      eventId: event.getId(),
      title: event.getTitle(),
      startsAt: event.getStartTime().toISOString(),
      endsAt: event.getEndTime().toISOString(),
      timeZone: CONFIG.TIME_ZONE
    });
  } catch (error) {
    console.error("Calendar bridge error: " + (error && error.stack ? error.stack : error));
    return json_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Richiesta vuota: invia un JSON tramite POST.");
  }
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (_) {
    throw new Error("Il contenuto ricevuto non è un JSON valido.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Formato della richiesta non valido.");
  }
  return body;
}

function authorize_(providedToken, properties) {
  const expectedToken = properties.getProperty("GOOGLE_BRIDGE_TOKEN") || "";
  const supplied = String(providedToken || "");
  if (!expectedToken || !constantTimeEquals_(supplied, expectedToken)) {
    throw new Error("Accesso non autorizzato o token non configurato.");
  }
}

function getCalendar_(properties) {
  const calendarId = properties.getProperty("GOOGLE_CALENDAR_ID") || "";
  if (!calendarId) throw new Error("GOOGLE_CALENDAR_ID non è configurato.");
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) throw new Error("Calendario Google non trovato o non accessibile.");
  return calendar;
}

function validateBookingId_(value) {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("ID prenotazione non valido.");
  }
  return id;
}

function combineLocalDateTime_(request, isEnd) {
  const date = String(request.date || request.data || request.bookingDate || request.start_date || "").trim();
  const time = String(isEnd
    ? (request.endTime || request.end_time || "")
    : (request.time || request.ora || request.orario || request.startTime || request.start_time || "")).trim();
  if (!date || !time) return "";
  // Il fuso orario del progetto Apps Script deve essere Europe/Rome.
  return date + "T" + time + ":00";
}

function parseDate_(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Data o orario mancanti (" + fieldName + "). Il sito deve inviare startsAt/endsAt in formato ISO.");
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error("Data o orario non validi (" + fieldName + "): " + value);
  }
  return date;
}

function upsertBookingEvent_(calendar, properties, bookingId, title, description, start, end) {
  const propertyKey = CONFIG.PROPERTY_PREFIX + bookingId;
  const savedEventId = properties.getProperty(propertyKey);
  let event = savedEventId ? calendar.getEventById(savedEventId) : null;

  // Se le proprietà sono state perse, cerca l'ID univoco nella descrizione.
  if (!event) {
    const candidates = calendar.getEvents(
      new Date(start.getTime() - 2 * 86400000),
      new Date(end.getTime() + 2 * 86400000)
    ).filter(function (candidate) {
      return (candidate.getDescription() || "").indexOf(CONFIG.EVENT_ID_PREFIX + bookingId) !== -1;
    });
    if (candidates.length) {
      event = candidates[0];
      candidates.slice(1).forEach(function (duplicate) {
        duplicate.deleteEvent();
      });
    }
  }

  if (event) {
    event.setTitle(title);
    event.setTime(start, end);
    event.setDescription(description);
  } else {
    event = calendar.createEvent(title, start, end, {
      description: description,
      guests: "",
      sendInvites: false
    });
  }

  properties.setProperty(propertyKey, event.getId());
  return event;
}

function deleteBookingEvent_(calendar, properties, bookingId) {
  const propertyKey = CONFIG.PROPERTY_PREFIX + bookingId;
  const savedEventId = properties.getProperty(propertyKey);
  let deleted = false;

  if (savedEventId) {
    const event = calendar.getEventById(savedEventId);
    if (event) {
      event.deleteEvent();
      deleted = true;
    }
    properties.deleteProperty(propertyKey);
  }

  // Fallback per recuperare l'evento anche se la proprietà non esiste più.
  if (!deleted) {
    const now = new Date();
    const candidates = calendar.getEvents(
      new Date(now.getTime() - 365 * 86400000),
      new Date(now.getTime() + 730 * 86400000)
    ).filter(function (candidate) {
      return (candidate.getDescription() || "").indexOf(CONFIG.EVENT_ID_PREFIX + bookingId) !== -1;
    });
    candidates.forEach(function (candidate) {
      candidate.deleteEvent();
    });
  }
}

function buildDescription_(description, bookingId) {
  const text = cleanText_(description || "", CONFIG.MAX_DESCRIPTION_LENGTH);
  const marker = CONFIG.EVENT_ID_PREFIX + bookingId;
  return text.indexOf(marker) >= 0 ? text : (text ? text + "\n\n" : "") + marker;
}

function cleanText_(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(0, maxLength);
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
