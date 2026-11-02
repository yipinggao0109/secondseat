import { loadAircraftProfile, type AircraftProfile } from '@/lib/checklist-schema';

export const runtime = 'edge';

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const WAV_FILENAME = /^[a-f0-9]{24}\.wav$/;

export async function GET(request: Request) {
  const filename = new URL(request.url).searchParams.get('audio') ?? '';
  if (!WAV_FILENAME.test(filename)) return new Response('Not found.', { status: 404 });

  try {
    const response = await fetch(`http://127.0.0.1:8787/audio/generated/${filename}`);
    if (!response.ok || !response.body) return new Response('Not found.', { status: 404 });
    return new Response(response.body, {
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Audio service unavailable.', { status: 503 });
  }
}

const EXTRACTION_PROMPT = `
Extract the aircraft checklist shown in the supplied images into the requested SecondSeat profile.
Preserve printed page order, section order, wording, capitalization, values, units, warnings, and emergency procedures.
Never invent an action, value, limitation, flight phase, aircraft configuration, or source page.
Use the user-provided display name as aircraft.displayName. If manufacturer or model is not visible, use "UNKNOWN" and add a warning.
Use sourcePage "UNKNOWN" when a page number is not visible and add a warning. Set sourceKind to "poh-checklist" only when the image identifies itself as POH/AFM material; otherwise use "prototype-supplement".
Every required string must be non-empty. Use group "Imported checklist" when no broader printed group heading is visible.
For a standalone instruction with no separate action or required-state column, put the complete printed instruction in challenge and return expected as an empty string. Do not duplicate the instruction into expected.
Use validator "exact" unless the printed action explicitly gives a numeric range. For range validators, populate numeric min and max.
Assign triggerPhase from an unambiguous printed checklist title using only these values: PARKED, TAXI, TAKEOFF, CLIMB, CRUISE, DESCENT, APPROACH, or LANDING. Examples: preflight/before start/starting engine map to PARKED; taxi maps to TAXI; before takeoff/takeoff map to TAKEOFF; climb maps to CLIMB; cruise maps to CRUISE; descent maps to DESCENT; before landing/approach map to APPROACH; landing/after landing map to LANDING. Return null when the title does not clearly identify one of these phases. Do not infer phaseDetection sensor thresholds from checklist titles.
Create stable lowercase kebab-case ids. Every item id must be unique within its section.
Add a concise warning for every unreadable, cropped, ambiguous, or missing piece of information. Do not silently repair uncertain text.
`.trim();

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;
const nonEmptyString = { type: 'string', minLength: 1 } as const;

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'warnings'],
  properties: {
    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'aircraft', 'source', 'modes', 'phaseDetection', 'checklists'],
      properties: {
        schemaVersion: { type: 'integer', enum: [1] },
        aircraft: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'manufacturer', 'model', 'displayName', 'year', 'configuration'],
          properties: {
            id: nonEmptyString, manufacturer: nonEmptyString, model: nonEmptyString, displayName: nonEmptyString,
            year: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            configuration: { type: 'array', items: nonEmptyString },
          },
        },
        source: {
          type: 'object', additionalProperties: false,
          required: ['kind', 'title', 'revision', 'url', 'note'],
          properties: { kind: nonEmptyString, title: nonEmptyString, revision: nullableString, url: nullableString, note: nullableString },
        },
        modes: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'label', 'description'],
            properties: { id: nonEmptyString, label: nonEmptyString, description: nonEmptyString },
          },
        },
        phaseDetection: {
          anyOf: [
            {
              type: 'object', additionalProperties: false,
              required: ['fieldElevationFt', 'taxiSpeedKt', 'airborneSpeedKt', 'climbRateFpm', 'descentRateFpm', 'cruiseVerticalBandFpm', 'approachAglFt', 'groundBandFt'],
              properties: {
                fieldElevationFt: { type: 'number' }, taxiSpeedKt: { type: 'number' }, airborneSpeedKt: { type: 'number' },
                climbRateFpm: { type: 'number' }, descentRateFpm: { type: 'number' }, cruiseVerticalBandFpm: { type: 'number' },
                approachAglFt: { type: 'number' }, groundBandFt: { type: 'number' },
              },
            },
            { type: 'null' },
          ],
        },
        checklists: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'name', 'category', 'group', 'sourcePage', 'sourceKind', 'appliesTo', 'triggerPhase', 'items'],
            properties: {
              id: nonEmptyString, name: nonEmptyString, category: { type: 'string', enum: ['normal', 'emergency'] },
              group: nonEmptyString, sourcePage: nonEmptyString,
              sourceKind: { type: 'string', enum: ['poh-checklist', 'poh-amplified', 'prototype-supplement'] },
              appliesTo: { anyOf: [{ type: 'string', enum: ['night'] }, { type: 'null' }] },
              triggerPhase: nullableString,
              items: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false,
                  required: ['id', 'challenge', 'expected', 'validator', 'min', 'max'],
                  properties: {
                    id: nonEmptyString, challenge: nonEmptyString, expected: { type: 'string' },
                    validator: { type: 'string', enum: ['exact', 'range'] }, min: nullableNumber, max: nullableNumber,
                  },
                },
              },
            },
          },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

function dataUrl(bytes: ArrayBuffer, contentType: string) {
  const values = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    binary += String.fromCharCode(...values.subarray(offset, offset + chunkSize));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => child === null ? [] : [[key, omitNulls(child)]]));
}

function profileWithDisplayName(profile: AircraftProfile, displayName: string): AircraftProfile {
  return { ...profile, aircraft: { ...profile.aircraft, displayName } };
}

function responseOutputText(response: Record<string, unknown>) {
  if (typeof response.output_text === 'string') return response.output_text;
  if (!Array.isArray(response.output)) return '';
  for (const item of response.output) {
    if (!item || typeof item !== 'object' || !Array.isArray((item as { content?: unknown }).content)) continue;
    for (const content of (item as { content: unknown[] }).content) {
      if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
        return (content as { text: string }).text;
      }
    }
  }
  return '';
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const suppliedApiKey = formData.get('apiKey');
    const apiKey = (typeof suppliedApiKey === 'string' ? suppliedApiKey.trim() : '') || process.env.OPENAI_API_KEY;
    if (!apiKey) return Response.json({ error: 'Enter an OpenAI API key to extract this checklist.' }, { status: 400 });
    const displayNameValue = formData.get('displayName');
    const displayName = typeof displayNameValue === 'string' ? displayNameValue.trim() : '';
    const images = formData.getAll('images').filter((value): value is File => value instanceof File);
    if (!displayName) return Response.json({ error: 'A checklist name is required.' }, { status: 400 });
    if (!images.length || images.length > MAX_IMAGES) return Response.json({ error: `Upload between 1 and ${MAX_IMAGES} images.` }, { status: 400 });
    for (const image of images) {
      if (!ALLOWED_IMAGE_TYPES.has(image.type)) return Response.json({ error: 'Only PNG and JPEG images are supported.' }, { status: 400 });
      if (image.size > MAX_IMAGE_BYTES) return Response.json({ error: 'Each image must be 16 MB or smaller.' }, { status: 400 });
    }

    const imageParts = await Promise.all(images.map(async (image) => ({ type: 'input_image', image_url: dataUrl(await image.arrayBuffer(), image.type), detail: 'high' })));
    const model = process.env.OPENAI_VISION_MODEL || 'gpt-6.1-terra';
    const openAIResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        reasoning: { effort: 'medium' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: `${EXTRACTION_PROMPT}\n\nUser-provided display name: ${displayName}` }, ...imageParts] }],
        text: { format: { type: 'json_schema', name: 'secondseat_checklist_extraction', strict: true, schema: extractionSchema } },
      }),
    });

    const responseBody = await openAIResponse.json() as Record<string, unknown>;
    if (!openAIResponse.ok) {
      const apiMessage = responseBody.error && typeof responseBody.error === 'object' ? (responseBody.error as { message?: unknown }).message : '';
      const apiError = typeof apiMessage === 'string' ? apiMessage : '';
      throw new Error(apiError || `OpenAI request failed with status ${openAIResponse.status}.`);
    }
    const outputText = responseOutputText(responseBody);
    if (!outputText) throw new Error('OpenAI returned no structured checklist output.');
    const extracted = JSON.parse(outputText) as { profile: unknown; warnings: unknown };
    const profile = profileWithDisplayName(loadAircraftProfile(omitNulls(extracted.profile)), displayName);
    const warnings = Array.isArray(extracted.warnings) ? extracted.warnings.filter((warning): warning is string => typeof warning === 'string') : [];
    return Response.json({ profile, warnings, model, reviewRequired: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Checklist extraction failed.' }, { status: 500 });
  }
}
