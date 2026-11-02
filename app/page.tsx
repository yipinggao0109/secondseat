'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, FileImage,
  Headphones, Mic, Pause, Plane, Play, RotateCcw, Satellite, ShieldCheck, Sparkles, Trash2, Upload, Volume2, X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { R182_PROFILE } from '@/lib/aircraft-profiles';
import { COMPLETE_FLIGHT_POINTS, DEMO_FLIGHT, formatFlightTime, segmentAt } from '@/lib/demo-flight-timeline';
import { detectFlightPhase, type FlightPhase } from '@/lib/flight-phase-detector';
import { extractChecklistImages } from '@/lib/checklist-import';
import {
  loadAircraftProfile,
  type AircraftProfile,
  type ChecklistCategory,
  type ChecklistItem,
  type ChecklistSection,
  type PhaseDetectionConfig,
} from '@/lib/checklist-schema';

type Stage = 'upload' | 'import' | 'review' | 'flight';
type SpeechRecognitionAlternative = { transcript: string; confidence?: number };
type SpeechRecognitionResultEvent = { results: ArrayLike<ArrayLike<SpeechRecognitionAlternative>> };
type SpeechRecognitionErrorEvent = { error: string };
type SpeechRecognitionInstance = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onstart: (() => void) | null; onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  start: () => void; abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;
type HoldShortStatus = 'inactive' | 'decision' | 'runup' | 'before-takeoff' | 'ready' | 'released';
type ChecklistSuggestion = {
  phase: FlightPhase;
  sectionId: string;
  sectionName: string;
};

const R182_CHECKLISTS = R182_PROFILE.checklists;

const PHASES: Array<{ name: FlightPhase; altitude: number; speed: number; vertical: number }> = [
  { name: 'PARKED', altitude: 620, speed: 0, vertical: 0 },
  { name: 'TAXI', altitude: 620, speed: 9, vertical: 0 },
  { name: 'TAKEOFF', altitude: 800, speed: 72, vertical: 700 },
  { name: 'CLIMB', altitude: 1200, speed: 82, vertical: 600 },
  { name: 'CRUISE', altitude: 3500, speed: 110, vertical: 0 },
  { name: 'DESCENT', altitude: 2200, speed: 105, vertical: -500 },
  { name: 'APPROACH', altitude: 1200, speed: 80, vertical: -350 },
  { name: 'LANDING', altitude: 640, speed: 58, vertical: -120 },
];

const R182_SOURCE_URL = R182_PROFILE.source.url ?? '#';
const HOLD_SHORT_SEGMENT = DEMO_FLIGHT.segments.find((segment) => segment.id === 'hold-short');
const HOLD_SHORT_START = HOLD_SHORT_SEGMENT?.startSecond ?? 420;
const TAKEOFF_START = HOLD_SHORT_SEGMENT?.endSecond ?? 720;
const HOLD_SHORT_PROMPT = 'Hold short. Run-up, or ready for takeoff?';

const NATURAL_VOICE_PROMPTS = new Set([
  HOLD_SHORT_PROMPT.toLowerCase(),
  ...R182_CHECKLISTS.flatMap((section) => [
    `${section.name.toLowerCase()} checklist complete.`,
    ...(section.triggerPhase
      ? [`${section.triggerPhase} detected. Start ${section.name} checklist? Say yes or tap confirm.`.toLowerCase()]
      : []),
    ...section.items.flatMap((item) => {
      const challenge = item.challenge.toLowerCase();
      return [
        `${challenge}?`,
        `${challenge}, confirmed.`,
        `${challenge} not confirmed.`,
        instructionFor(item).toLowerCase(),
      ];
    }),
  ]),
]);

let activeVoiceAudio: HTMLAudioElement | null = null;
let cancelActiveRecognition: (() => void) | null = null;
const generatedVoiceAssets = new Map<string, string>();
const VOICE_ASSET_STORAGE_KEY = 'secondseat.kokoro-assets.v2';
function currentGeneratedAsset(asset: string) {
  const filename = asset.match(/\/audio\/generated\/([a-f0-9]{24}\.wav)(?:$|[?#])/)?.[1]
    ?? asset.match(/[?&](?:file|audio)=([a-f0-9]{24}\.wav)(?:$|&)/)?.[1];
  return filename ? `/api/checklists/extract?audio=${filename}` : asset;
}

function normalize(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9\s.-]/g, '').replace(/\s+/g, ' ').trim();
}

function instructionFor(item: ChecklistItem) {
  const challenge = item.challenge.trim().replace(/[.]+$/, '');
  const expected = item.expected.trim().replace(/[.]+$/, '');
  return expected ? `${challenge}. ${expected}.` : `${challenge}.`;
}

function voicePromptsForProfile(profile: AircraftProfile) {
  return new Set(profile.checklists.flatMap((section) => [
    `${section.name.toLowerCase()} checklist complete.`,
    ...(section.triggerPhase ? [`${section.triggerPhase} detected. Start ${section.name} checklist? Say yes or tap confirm.`] : []),
    ...section.items.map(instructionFor),
  ]).map((prompt) => prompt.toLowerCase()));
}

function isAcknowledgement(value: string) {
  return ['CHECKED', 'CHECK', 'NEXT'].includes(normalize(value));
}

function isBackCommand(value: string) {
  return ['BACK', 'GO BACK', 'PREVIOUS'].includes(normalize(value));
}

function firstSliderValue(value: number | readonly number[]) {
  return typeof value === 'number' ? value : (value[0] ?? 0);
}

function voiceAssetFor(text: string) {
  const normalized = text.toLowerCase();
  const generatedAsset = generatedVoiceAssets.get(normalized);
  if (generatedAsset) return generatedAsset;
  if (!NATURAL_VOICE_PROMPTS.has(normalized)) return null;
  const questionSuffix = normalized.endsWith('?') ? '-question' : '';
  const stem = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `/audio/kokoro/${stem}${questionSuffix}.wav`;
}

function stopSpeech() {
  if (typeof window === 'undefined') return;
  if (activeVoiceAudio) {
    activeVoiceAudio.pause();
    activeVoiceAudio.currentTime = 0;
    activeVoiceAudio = null;
  }
  window.speechSynthesis?.cancel();
}

function stopListening() {
  cancelActiveRecognition?.();
  cancelActiveRecognition = null;
}

function speak(text: string, onEnd?: () => void) {
  if (typeof window === 'undefined') return;
  stopListening();
  stopSpeech();
  const asset = voiceAssetFor(text);
  if (!asset) {
    console.error(`[SecondSeat voice] Missing Kokoro audio: ${text}`);
    onEnd?.();
    return;
  }
  console.info(`[SecondSeat voice] Kokoro WAV ${asset}: ${text}`);
  const audio = new Audio(asset);
  activeVoiceAudio = audio;
  audio.onended = () => {
    if (activeVoiceAudio === audio) activeVoiceAudio = null;
    onEnd?.();
  };
  audio.onerror = () => {
    if (activeVoiceAudio !== audio) return;
    activeVoiceAudio = null;
    console.error(`[SecondSeat voice] Could not load Kokoro WAV ${asset}`);
    onEnd?.();
  };
  void audio.play().catch(() => {
    if (activeVoiceAudio !== audio) return;
    activeVoiceAudio = null;
    console.error(`[SecondSeat voice] Could not play Kokoro WAV ${asset}`);
    onEnd?.();
  });
}

export default function Home() {
  const [stage, setStage] = useState<Stage>('upload');
  const [extracting, setExtracting] = useState(false);
  const [nightMode, setNightMode] = useState(false);
  const [reviewCategory, setReviewCategory] = useState<ChecklistCategory>('normal');
  const [checklist, setChecklist] = useState<ChecklistSection[]>(R182_CHECKLISTS.filter((section) => !section.appliesTo));
  const [aircraftName, setAircraftName] = useState('1981 Cessna R182 Skylane RG');
  const [sourceLabel, setSourceLabel] = useState('1981 R182 POH reference');
  const [sourceUrl, setSourceUrl] = useState<string | null>(R182_SOURCE_URL);
  const [importName, setImportName] = useState('');
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importReviewNote, setImportReviewNote] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importedProfile, setImportedProfile] = useState<AircraftProfile | null>(null);
  const [savedProfiles, setSavedProfiles] = useState<AircraftProfile[]>([]);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [registryMessage, setRegistryMessage] = useState('');
  const [savingChecklist, setSavingChecklist] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [voicePreparing, setVoicePreparing] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [phaseDetectionConfig, setPhaseDetectionConfig] = useState<PhaseDetectionConfig>(R182_PROFILE.phaseDetection!);
  const [gpsAutoDetect, setGpsAutoDetect] = useState(false);
  const [gpsPlaying, setGpsPlaying] = useState(false);
  const [timelineSecond, setTimelineSecond] = useState(0);
  const [checklistSuggestions, setChecklistSuggestions] = useState<ChecklistSuggestion[]>([]);
  const [queuedChecklists, setQueuedChecklists] = useState<ChecklistSuggestion[]>([]);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [itemIndex, setItemIndex] = useState(0);
  const [response, setResponse] = useState('');
  const [notice, setNotice] = useState('');
  const [speechInputSupported, setSpeechInputSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [holdShortStatus, setHoldShortStatus] = useState<HoldShortStatus>('inactive');
  const [runupComplete, setRunupComplete] = useState(false);
  const checklistCommandRef = useRef<(command: 'next' | 'back') => void>(() => undefined);
  const retryListeningRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const timer = window.setTimeout(() => {
      setSpeechInputSupported(Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('http://127.0.0.1:8787/checklists', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Saved checklist registry is unavailable.');
        return await response.json() as { profiles?: unknown[] };
      })
      .then((payload) => {
        const profiles = (payload.profiles ?? []).flatMap((candidate) => {
          try {
            return [loadAircraftProfile(candidate)];
          } catch {
            return [];
          }
        }).filter((profile) => profile.aircraft.id !== R182_PROFILE.aircraft.id);
        setSavedProfiles(profiles);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) console.warn(error);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(VOICE_ASSET_STORAGE_KEY) || '{}') as Record<string, unknown>;
      for (const [text, asset] of Object.entries(stored)) {
        if (typeof asset === 'string' && (asset.includes('/audio/generated/') || asset.includes('/api/checklists/extract?audio=') || asset.startsWith('/api/audio/generated?file='))) {
          generatedVoiceAssets.set(text, currentGeneratedAsset(asset));
        }
      }
      window.localStorage.setItem(VOICE_ASSET_STORAGE_KEY, JSON.stringify(Object.fromEntries(generatedVoiceAssets)));
    } catch {
      window.localStorage.removeItem(VOICE_ASSET_STORAGE_KEY);
    }
  }, []);

  const phase = PHASES[phaseIndex];
  const gpsSample = COMPLETE_FLIGHT_POINTS[timelineSecond];
  const timelineSegment = segmentAt(timelineSecond);
  const gpsDetection = detectFlightPhase(gpsSample, phaseDetectionConfig, phase.name);
  const telemetry = gpsAutoDetect
    ? { altitude: gpsSample.altitudeFt, speed: gpsSample.groundSpeedKt, vertical: gpsSample.verticalSpeedFpm }
    : phase;
  const activeSection = checklist.find((section) => section.id === activeSectionId);
  const currentItem = activeSection?.items[itemIndex];
  const confirmedCount = activeSection?.items.filter((item) => item.status === 'confirmed').length ?? 0;
  const isComplete = Boolean(activeSection && confirmedCount === activeSection.items.length);
  const progress = useMemo(() => activeSection ? Math.round((confirmedCount / activeSection.items.length) * 100) : 0, [activeSection, confirmedCount]);
  const normalCount = checklist.filter((section) => section.category === 'normal').length;
  const emergencyCount = checklist.filter((section) => section.category === 'emergency').length;
  const checklistSuggestion = checklistSuggestions[0];
  const activeChecklistRunning = Boolean(activeSection && !isComplete);
  const holdShortFlowAvailable = checklist.some((section) => section.id === 'engine-run-up')
    && checklist.some((section) => section.id === 'before-takeoff');
  const holdShortGateOpen = !['inactive', 'released'].includes(holdShortStatus);
  const holdShortChoiceBlocked = activeChecklistRunning || Boolean(checklistSuggestion);

  useEffect(() => {
    if (stage !== 'flight' || !activeSectionId || isComplete) {
      stopListening();
    }
  }, [activeSectionId, isComplete, stage]);

  const startListening = useCallback(() => {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setNotice('Speech input is unavailable in this browser. Use the on-screen button.');
      return;
    }
    stopListening();
    stopSpeech();
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 5;
    let shouldRetry = true;
    const cancelThisRecognition = () => {
      shouldRetry = false;
      recognition.abort();
    };
    cancelActiveRecognition = cancelThisRecognition;
    recognition.onstart = () => {
      setListening(true);
      setNotice('Listening… say “checked”, “next”, or “back”.');
    };
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const alternatives = result
        ? Array.from({ length: result.length }, (_, index) => result[index]?.transcript?.trim()).filter((value): value is string => Boolean(value))
        : [];
      const firstTranscript = alternatives[0];
      if (!firstTranscript) return;

      const commandCandidate = alternatives.find(isAcknowledgement);
      const backCandidate = alternatives.find(isBackCommand);
      if (commandCandidate || backCandidate) {
        shouldRetry = false;
        recognition.abort();
        const command = backCandidate ? 'back' : 'next';
        setResponse(commandCandidate ?? backCandidate ?? '');
        checklistCommandRef.current(command);
      } else {
        setNotice(`Heard “${firstTranscript}”. Say “checked”, “next”, or “back”.`);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') shouldRetry = false;
      setListening(false);
      const message = event.error === 'not-allowed'
        ? 'Microphone permission was denied. Use the on-screen button.'
        : 'Speech was not recognized. Listening again…';
      setNotice(message);
    };
    recognition.onend = () => {
      if (cancelActiveRecognition === cancelThisRecognition) cancelActiveRecognition = null;
      setListening(false);
      if (shouldRetry) window.setTimeout(() => retryListeningRef.current(), 350);
    };
    recognition.start();
  }, []);

  function loadDemo() {
    setExtracting(true);
    window.setTimeout(() => {
      const selected = R182_CHECKLISTS.filter((section) => !section.appliesTo || nightMode);
      setChecklist(selected.map((section) => ({ ...section, items: section.items.map((item) => ({ ...item })) })));
      setAircraftName('1981 Cessna R182 Skylane RG');
      setPhaseDetectionConfig(R182_PROFILE.phaseDetection!);
      setSourceLabel('1981 R182 POH reference');
      setSourceUrl(R182_SOURCE_URL);
      setImportReviewNote(null);
      setImportedProfile(null);
      setSaveMessage('');
      setImportWarnings([]);
      setVoiceError('');
      setReviewCategory('normal');
      setReviewed(false);
      setChecklistSuggestions([]);
      setQueuedChecklists([]);
      setHoldShortStatus('inactive');
      setRunupComplete(false);
      setExtracting(false);
      setStage('review');
    }, 850);
  }

  function loadSavedProfile(profile: AircraftProfile) {
    setChecklist(profile.checklists.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item })),
    })));
    setAircraftName(profile.aircraft.displayName);
    setPhaseDetectionConfig(profile.phaseDetection ?? R182_PROFILE.phaseDetection!);
    setSourceLabel(profile.source.title);
    setSourceUrl(profile.source.url ?? null);
    setImportName(profile.aircraft.displayName);
    setImportedProfile(profile);
    setImportReviewNote('Loaded from saved JSON.');
    setImportWarnings([]);
    setSaveMessage('');
    setVoiceError('');
    setReviewCategory('normal');
    setReviewed(false);
    setChecklistSuggestions([]);
    setQueuedChecklists([]);
    setHoldShortStatus('inactive');
    setRunupComplete(false);
    setStage('review');
  }

  async function deleteSavedProfile(profile: AircraftProfile) {
    if (!window.confirm(`Delete ${profile.aircraft.displayName}? This removes its saved JSON from this computer.`)) return;
    setDeletingProfileId(profile.aircraft.id);
    setRegistryMessage('');
    try {
      const response = await fetch('http://127.0.0.1:8787/delete-checklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aircraftId: profile.aircraft.id }),
      });
      const payload = await response.json().catch(() => null) as { deleted?: boolean; error?: string } | null;
      if (!response.ok || !payload?.deleted) throw new Error(payload?.error || 'Could not delete the checklist.');

      for (const prompt of voicePromptsForProfile(profile)) generatedVoiceAssets.delete(prompt);
      window.localStorage.setItem(VOICE_ASSET_STORAGE_KEY, JSON.stringify(Object.fromEntries(generatedVoiceAssets)));
      setSavedProfiles((current) => current.filter((saved) => saved.aircraft.id !== profile.aircraft.id));
      if (importedProfile?.aircraft.id === profile.aircraft.id) setImportedProfile(null);
      setRegistryMessage(`${profile.aircraft.displayName} deleted.`);
    } catch (error) {
      setRegistryMessage(error instanceof Error ? error.message : 'Could not delete the checklist.');
    } finally {
      setDeletingProfileId(null);
    }
  }

  function selectImportFiles(files: FileList | null) {
    if (!files) return;
    const candidates = Array.from(files);
    const invalid = candidates.find((file) => !['image/jpeg', 'image/png'].includes(file.type));
    const oversized = candidates.find((file) => file.size > 16 * 1024 * 1024);
    if (invalid) {
      setImportError('Use PNG or JPEG images only.');
      return;
    }
    if (oversized) {
      setImportError('Each image must be 16 MB or smaller.');
      return;
    }
    setImportFiles((current) => {
      const combined = [...current, ...candidates].filter((file, index, all) =>
        all.findIndex((candidate) => candidate.name === file.name && candidate.size === file.size) === index);
      if (combined.length > 8) {
        setImportError('Add up to 8 images per checklist.');
        return combined.slice(0, 8);
      }
      setImportError('');
      return combined;
    });
  }

  async function extractImportedChecklist() {
    const displayName = importName.trim();
    if (!displayName) {
      setImportError('Name this aircraft or checklist first.');
      return;
    }
    if (!importFiles.length) {
      setImportError('Add at least one checklist image.');
      return;
    }

    setImporting(true);
    setImportError('');
    try {
      const result = await extractChecklistImages(displayName, importFiles);
      setChecklist(result.profile.checklists.map((section) => ({
        ...section,
        items: section.items.map((item) => ({ ...item })),
      })));
      setAircraftName(result.profile.aircraft.displayName);
      setSourceLabel(result.profile.source.title);
      setSourceUrl(result.profile.source.url ?? null);
      setImportReviewNote(`Extracted with ${result.model}.`);
      setImportedProfile(result.profile);
      setSaveMessage('');
      setImportWarnings(result.warnings);
      setPhaseDetectionConfig(result.profile.phaseDetection ?? R182_PROFILE.phaseDetection!);
      setReviewCategory('normal');
      setReviewed(false);
      setChecklistSuggestions([]);
      setQueuedChecklists([]);
      setHoldShortStatus('inactive');
      setRunupComplete(false);
      setVoiceError('');
      setStage('review');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not build the checklist draft.');
    } finally {
      setImporting(false);
    }
  }

  function updateItem(sectionId: string, itemId: string, field: 'challenge' | 'expected', value: string) {
    setChecklist((current) => current.map((section) => section.id === sectionId
      ? { ...section, items: section.items.map((item) => item.id === itemId ? { ...item, [field]: value } : item) }
      : section));
  }

  async function saveImportedChecklist() {
    if (!importedProfile) return;
    setSavingChecklist(true);
    setSaveMessage('');
    try {
      const cleanChecklists = checklist.map((section) => ({
        ...section,
        items: section.items.map(({ status: _status, response: _response, ...item }) => item),
      }));
      const profile = loadAircraftProfile({ ...importedProfile, checklists: cleanChecklists });
      const response = await fetch('http://127.0.0.1:8787/save-checklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const payload = await response.json().catch(() => null) as { path?: string; error?: string } | null;
      if (!response.ok || !payload?.path) throw new Error(payload?.error || 'Could not save the checklist JSON.');
      setImportedProfile(profile);
      setSaveMessage(`Saved to ${payload.path}`);
      setSavedProfiles((current) => [profile, ...current.filter((saved) => saved.aircraft.id !== profile.aircraft.id)]);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Could not save the checklist JSON.');
    } finally {
      setSavingChecklist(false);
    }
  }

  function startFlight() {
    setStage('flight');
    setPhaseIndex(0);
    setGpsAutoDetect(true);
    setGpsPlaying(true);
    setTimelineSecond(0);
    setChecklistSuggestions([]);
    setQueuedChecklists([]);
    setHoldShortStatus('inactive');
    setRunupComplete(false);
    setActiveSectionId(null);
    setNotice('Complete GPS flight connected. Waiting for the first checklist suggestion.');
  }

  async function prepareVoiceAndStartFlight() {
    const allPrompts = Array.from(new Set([
      HOLD_SHORT_PROMPT,
      ...checklist.flatMap((section) => [
        `${section.name.toLowerCase()} checklist complete.`,
        ...(section.triggerPhase ? [`${section.triggerPhase} detected. Start ${section.name} checklist? Say yes or tap confirm.`] : []),
        ...section.items.map(instructionFor),
      ]),
    ]));
    const prompts = allPrompts.filter((prompt) => importedProfile
      ? !generatedVoiceAssets.has(prompt.toLowerCase())
      : !voiceAssetFor(prompt));

    if (!prompts.length) {
      startFlight();
      return;
    }

    setVoicePreparing(true);
    setVoiceError('');
    try {
      const response = await fetch('http://127.0.0.1:8787/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: prompts }),
      });
      const payload = await response.json().catch(() => null) as { assets?: Record<string, string>; error?: string } | null;
      if (!response.ok || !payload?.assets) throw new Error(payload?.error || 'Local Kokoro service is unavailable.');
      for (const [text, asset] of Object.entries(payload.assets)) generatedVoiceAssets.set(text.toLowerCase(), currentGeneratedAsset(asset));
      window.localStorage.setItem(VOICE_ASSET_STORAGE_KEY, JSON.stringify(Object.fromEntries(generatedVoiceAssets)));
      startFlight();
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : 'Could not generate Kokoro voice prompts.');
    } finally {
      setVoicePreparing(false);
    }
  }

  function toggleGpsDemo() {
    if (gpsAutoDetect) {
      if (holdShortGateOpen) {
        setNotice('Hold short — choose Run-up or Ready for takeoff.');
        return;
      }
      if (!gpsPlaying && timelineSecond >= DEMO_FLIGHT.durationSeconds) {
        setTimelineSecond(0);
        setHoldShortStatus('inactive');
        setRunupComplete(false);
      }
      setGpsPlaying((current) => !current);
      setNotice(gpsPlaying ? 'Complete-flight playback paused. Drag the timeline to inspect any moment.' : 'Complete-flight playback resumed.');
      return;
    }
    setGpsAutoDetect(true);
    setGpsPlaying(true);
    setTimelineSecond(0);
    setHoldShortStatus('inactive');
    setRunupComplete(false);
    setNotice('Complete GPS flight connected. Playback advances five simulated seconds per real second.');
  }

  const activateChecklist = useCallback((sectionId: string) => {
    const selectedSection = checklist.find((section) => section.id === sectionId);
    if (!selectedSection) return;
    const resetSection = {
      ...selectedSection,
      items: selectedSection.items.map((item) => ({ ...item, status: undefined, response: undefined })),
    };
    setChecklist((current) => current.map((section) => section.id === selectedSection.id ? resetSection : section));
    setChecklistSuggestions((current) => current.filter((suggestion) => suggestion.sectionId !== selectedSection.id));
    setQueuedChecklists((current) => current.filter((suggestion) => suggestion.sectionId !== selectedSection.id));
    setActiveSectionId(selectedSection.id);
    setItemIndex(0);
    setResponse('');
    setNotice(`${selectedSection.name} checklist activated.`);
    window.setTimeout(() => speak(instructionFor(selectedSection.items[0]), startListening), 120);
  }, [checklist, startListening]);

  const moveToPhase = useCallback((nextIndex: number, source: 'manual' | 'gps' | 'scrub' = 'manual') => {
    const safeIndex = Math.max(0, Math.min(PHASES.length - 1, nextIndex));
    const nextPhase = PHASES[safeIndex];
    setPhaseIndex(safeIndex);
    const matchingSection = checklist.find((section) => section.triggerPhase === nextPhase.name);
    if (matchingSection && source === 'gps') {
      if (nextPhase.name === 'TAKEOFF') setGpsPlaying(false);
      const suggestion = { phase: nextPhase.name, sectionId: matchingSection.id, sectionName: matchingSection.name };
      const isCurrentChecklist = activeChecklistRunning && activeSectionId === matchingSection.id;
      const isAlreadyKnown = checklistSuggestions.some((item) => item.sectionId === matchingSection.id)
        || queuedChecklists.some((item) => item.sectionId === matchingSection.id);
      if (!isCurrentChecklist && !isAlreadyKnown) {
        setChecklistSuggestions((current) => current.length >= 3 ? current : [...current, suggestion]);
        setNotice(`${nextPhase.name} detected. ${matchingSection.name} is waiting for pilot confirmation.`);
        if (!activeChecklistRunning && checklistSuggestions.length === 0) {
          speak(`${nextPhase.name} detected. Start ${matchingSection.name} checklist? Say yes or tap confirm.`);
        }
      }
    } else if (matchingSection && source === 'manual') {
      setResponse('');
      activateChecklist(matchingSection.id);
    } else if (source === 'manual') {
      setActiveSectionId(null);
      setNotice(`No checklist is assigned to ${nextPhase.name.toLowerCase()} in this demo.`);
    }
  }, [activateChecklist, activeChecklistRunning, activeSectionId, checklist, checklistSuggestions, queuedChecklists]);

  useEffect(() => {
    if (!gpsAutoDetect || !gpsPlaying || stage !== 'flight') return;
    const timer = window.setTimeout(() => {
      const nextSecond = Math.min(timelineSecond + DEMO_FLIGHT.playbackStepSeconds, DEMO_FLIGHT.durationSeconds);
      if (
        holdShortFlowAvailable
        && holdShortStatus !== 'released'
        && timelineSecond < HOLD_SHORT_START
        && nextSecond >= HOLD_SHORT_START
      ) {
        setTimelineSecond(HOLD_SHORT_START);
        setPhaseIndex(PHASES.findIndex((candidate) => candidate.name === 'TAXI'));
        setGpsPlaying(false);
        setHoldShortStatus('decision');
        setNotice('Hold short — choose Run-up or Ready for takeoff.');
        if (!activeChecklistRunning && !checklistSuggestion) {
          speak(HOLD_SHORT_PROMPT);
        }
        return;
      }
      const nextSample = COMPLETE_FLIGHT_POINTS[nextSecond];
      const nextDetection = detectFlightPhase(nextSample, phaseDetectionConfig, phase.name);
      const detectedIndex = PHASES.findIndex((candidate) => candidate.name === nextDetection.phase);
      setTimelineSecond(nextSecond);
      if (detectedIndex >= 0 && detectedIndex !== phaseIndex) moveToPhase(detectedIndex, 'gps');
      if (nextSecond >= DEMO_FLIGHT.durationSeconds) {
        setGpsPlaying(false);
        setNotice('Complete flight finished. Drag the timeline to review any phase or press play to restart.');
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [activeChecklistRunning, checklistSuggestion, gpsAutoDetect, gpsPlaying, holdShortFlowAvailable, holdShortStatus, moveToPhase, phase.name, phaseDetectionConfig, phaseIndex, stage, startListening, timelineSecond]);

  function previewFlightTimeline(second: number) {
    const safeSecond = Math.max(0, Math.min(DEMO_FLIGHT.durationSeconds, Math.round(second)));
    const sample = COMPLETE_FLIGHT_POINTS[safeSecond];
    const detection = detectFlightPhase(sample, phaseDetectionConfig, phase.name);
    const detectedIndex = PHASES.findIndex((candidate) => candidate.name === detection.phase);
    setGpsAutoDetect(true);
    setGpsPlaying(false);
    setTimelineSecond(safeSecond);
    if (detectedIndex >= 0) moveToPhase(detectedIndex, 'scrub');
  }

  function commitFlightTimeline(second: number) {
    const safeSecond = Math.max(0, Math.min(DEMO_FLIGHT.durationSeconds, Math.round(second)));
    if (holdShortFlowAvailable) {
      if (safeSecond >= HOLD_SHORT_START && safeSecond < TAKEOFF_START) {
        setHoldShortStatus('decision');
        setGpsPlaying(false);
      } else {
        setHoldShortStatus(safeSecond < HOLD_SHORT_START ? 'inactive' : 'released');
      }
    }
    const sample = COMPLETE_FLIGHT_POINTS[safeSecond];
    const detection = detectFlightPhase(sample, phaseDetectionConfig, phase.name);
    const detectedIndex = PHASES.findIndex((candidate) => candidate.name === detection.phase);
    if (detectedIndex >= 0) moveToPhase(detectedIndex, 'gps');
    setNotice(`Timeline moved to ${formatFlightTime(safeSecond)} · ${segmentAt(safeSecond).label}.`);
  }

  function confirmChecklistSuggestion() {
    if (!checklistSuggestion) return;
    setChecklistSuggestions((current) => current.slice(1));
    if (activeChecklistRunning) {
      setQueuedChecklists((current) => current.some((item) => item.sectionId === checklistSuggestion.sectionId)
        ? current
        : [...current, checklistSuggestion]);
      setNotice(`${checklistSuggestion.sectionName} queued. The active checklist will not be interrupted.`);
      return;
    }
    activateChecklist(checklistSuggestion.sectionId);
  }

  function dismissChecklistSuggestion() {
    if (!checklistSuggestion) return;
    const dismissedTakeoff = checklistSuggestion.sectionId === 'normal-takeoff';
    setChecklistSuggestions((current) => current.slice(1));
    setNotice(`${checklistSuggestion.sectionName} dismissed for now.`);
    if (dismissedTakeoff) setGpsPlaying(true);
  }

  function chooseHoldShort(choice: 'runup' | 'takeoff') {
    if (holdShortChoiceBlocked) {
      setNotice('Finish or dismiss the current checklist prompt first.');
      return;
    }
    if (choice === 'runup') {
      setHoldShortStatus('runup');
      activateChecklist('engine-run-up');
      return;
    }
    setHoldShortStatus('before-takeoff');
    activateChecklist('before-takeoff');
  }

  function releaseHoldShort() {
    stopListening();
    stopSpeech();
    setHoldShortStatus('released');
    setTimelineSecond(TAKEOFF_START);
    setPhaseIndex(PHASES.findIndex((candidate) => candidate.name === 'TAXI'));
    setGpsPlaying(true);
    setNotice('Takeoff clearance acknowledged. Demo continuing to the takeoff roll.');
  }

  function submitResponse(spokenResponse?: string) {
    const answer = (spokenResponse ?? response).trim();
    if (!activeSection || !currentItem || !answer) return;
    if (!isAcknowledgement(answer)) {
      setNotice(`Heard “${answer}”. Say “checked” or “next” to continue.`);
      return;
    }
    const acknowledgedAs = normalize(answer) === 'NEXT' ? 'NEXT' : 'CHECKED';
    setChecklist((current) => current.map((section) => section.id === activeSection.id
      ? { ...section, items: section.items.map((item) => item.id === currentItem.id ? { ...item, status: 'confirmed', response: acknowledgedAs } : item) }
      : section));
    setNotice(`${currentItem.challenge} checked.`);
    const nextIndex = itemIndex + 1;
    if (nextIndex < activeSection.items.length) {
      setItemIndex(nextIndex);
      setResponse('');
      window.setTimeout(() => speak(instructionFor(activeSection.items[nextIndex]), startListening), 420);
    } else {
      setResponse('');
      const completedSectionId = activeSection.id;
      window.setTimeout(() => speak(`${activeSection.name.toLowerCase()} checklist complete.`, () => {
        if (completedSectionId === 'engine-run-up') {
          setRunupComplete(true);
          setHoldShortStatus('decision');
          setNotice('Run-up complete. Choose Ready for takeoff when ready.');
          window.setTimeout(() => speak(HOLD_SHORT_PROMPT), 250);
        } else if (completedSectionId === 'before-takeoff') {
          setHoldShortStatus('ready');
          setNotice('Before Takeoff complete. Confirm when ready to line up.');
        } else if (completedSectionId === 'normal-takeoff' && gpsAutoDetect) {
          setGpsPlaying(true);
          setNotice('Normal Takeoff complete. Demo continuing to climb.');
        }
      }), 420);
      const nextQueuedChecklist = queuedChecklists[0];
      if (nextQueuedChecklist) {
        setQueuedChecklists((current) => current.slice(1));
        setNotice(`${activeSection.name} complete. ${nextQueuedChecklist.sectionName} will start next.`);
        window.setTimeout(() => activateChecklist(nextQueuedChecklist.sectionId), 2200);
      }
    }
  }

  function advanceFromButton() {
    stopListening();
    submitResponse('next');
  }

  function goBack() {
    if (!activeSection || itemIndex === 0) {
      setNotice('Already at the first item. Say “checked” or “next” to continue.');
      window.setTimeout(startListening, 350);
      return;
    }
    const previousIndex = itemIndex - 1;
    const previousItem = activeSection.items[previousIndex];
    setChecklist((current) => current.map((section) => section.id === activeSection.id
      ? { ...section, items: section.items.map((item) => item.id === previousItem.id ? { ...item, status: undefined, response: undefined } : item) }
      : section));
    setItemIndex(previousIndex);
    setResponse('');
    setNotice(`Back to ${previousItem.challenge}.`);
    window.setTimeout(() => speak(instructionFor(previousItem), startListening), 250);
  }

  useEffect(() => {
    checklistCommandRef.current = (command) => command === 'back' ? goBack() : submitResponse('next');
    retryListeningRef.current = startListening;
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/8 bg-[#08100f]/92 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 md:px-8">
          <button className="flex items-center gap-3 text-left" onClick={() => setStage('upload')} aria-label="Return to SecondSeat home">
            <span className="grid size-10 place-items-center rounded-xl border border-[#b8ff58]/25 bg-[#b8ff58]/10 text-[#b8ff58]"><Headphones className="size-5" /></span>
            <span><span className="block text-sm font-semibold tracking-[0.18em] text-white">SECONDSEAT</span><span className="block text-[10px] uppercase tracking-[0.18em] text-[#8ea29e]">Voice checklist partner</span></span>
          </button>
          <Badge className="border border-amber-400/25 bg-amber-400/10 text-amber-200">DEMO ONLY</Badge>
        </div>
      </header>

      {stage === 'upload' && (
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-12 md:min-h-[calc(100vh-145px)] md:grid-cols-[1.05fr_.95fr] md:px-8 md:py-16">
          <div className="max-w-2xl">
            <h1 className="text-balance text-5xl font-semibold leading-[1.03] tracking-[-0.045em] text-white md:text-7xl">Keep your eyes up.<br /><span className="text-[#a8bbb6]">Run the checklist.</span></h1>
            <p className="mt-7 max-w-xl text-lg leading-8 text-[#a8bbb6]">Turn a pilot-reviewed aircraft checklist into spoken action prompts with hands-free voice control.</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button onClick={loadDemo} disabled={extracting} className="h-12 rounded-xl bg-[#b8ff58] px-5 text-sm font-semibold text-[#07100e] hover:bg-[#c7ff7c]">
                {extracting ? <><Sparkles className="animate-pulse" /> Loading demo checklist…</> : <><FileImage /> Use R182 Skylane RG <ArrowRight /></>}
              </Button>
              <Button onClick={() => { setImportError(''); setStage('import'); }} variant="outline" className="h-12 rounded-xl border-white/12 bg-white/4 px-5 text-[#a8bbb6] hover:bg-white/8 hover:text-white"><Upload className="size-4" /> Upload images</Button>
            </div>
            {(savedProfiles.length > 0 || registryMessage) && <div className="mt-5 max-w-xl rounded-xl border border-cyan-300/15 bg-cyan-300/5 p-4"><p className="text-[10px] font-semibold tracking-[0.16em] text-cyan-100">SAVED CHECKLISTS</p>{savedProfiles.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{savedProfiles.map((profile) => <div key={profile.aircraft.id} className="flex overflow-hidden rounded-lg border border-cyan-300/15 bg-[#07100f]"><Button type="button" variant="ghost" onClick={() => loadSavedProfile(profile)} className="h-10 rounded-none border-0 text-[#a8bbb6] hover:bg-cyan-300/10 hover:text-white"><FileImage /> {profile.aircraft.displayName}</Button><Button type="button" variant="ghost" disabled={deletingProfileId === profile.aircraft.id} onClick={() => void deleteSavedProfile(profile)} aria-label={`Delete ${profile.aircraft.displayName}`} title={`Delete ${profile.aircraft.displayName}`} className="h-10 w-10 rounded-none border-l border-cyan-300/15 px-0 text-[#6f837e] hover:bg-red-400/10 hover:text-red-200">{deletingProfileId === profile.aircraft.id ? <Sparkles className="size-4 animate-pulse" /> : <Trash2 className="size-4" />}</Button></div>)}</div>}{registryMessage && <p role="status" className="mt-3 text-xs text-[#8ea29e]">{registryMessage}</p>}</div>}
            <label htmlFor="night-mode" className="mt-5 flex w-fit cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/[.035] px-4 py-3 text-sm text-[#a8bbb6]">
              <Checkbox id="night-mode" checked={nightMode} onCheckedChange={(value) => setNightMode(Boolean(value))} className="border-white/20 data-checked:border-[#b8ff58] data-checked:bg-[#b8ff58] data-checked:text-[#07100f]" />
              <span><strong className="font-medium text-white">Night operations</strong><span className="ml-2 text-xs text-[#6f837e]">Add lighting and flashlight prompts</span></span>
            </label>
          </div>

          <div className="relative rounded-[28px] border border-white/10 bg-[#0c1715] p-3 shadow-2xl shadow-black/30">
            <div className="absolute -inset-16 -z-10 bg-[radial-gradient(circle,rgba(184,255,88,.09),transparent_64%)]" />
            <div className="rounded-[22px] border border-white/8 bg-[#07100f] p-5 md:p-7">
              <div className="flex items-center justify-between border-b border-white/8 pb-5"><div><p className="text-[10px] font-semibold tracking-[0.2em] text-[#6f837e]">SIMULATED FLIGHT DATA</p><p className="mt-1 text-lg font-medium text-white">APPROACH · R182 RG</p></div><span className="flex items-center gap-2 text-xs text-[#b8ff58]"><span className="size-2 rounded-full bg-[#b8ff58] shadow-[0_0_12px_#b8ff58]" /> ACTIVE</span></div>
              <div className="grid grid-cols-3 gap-3 border-b border-white/8 py-5">
                {[['ALTITUDE', '1,200', 'FT'], ['GROUND SPEED', '80', 'KT'], ['VERTICAL SPEED', '−350', 'FPM']].map(([label, value, unit]) => <div key={label}><p className="text-[9px] tracking-[0.12em] text-[#6f837e]">{label}</p><p className="mt-2 font-mono text-xl text-white md:text-2xl">{value}</p><p className="font-mono text-[10px] text-[#6f837e]">{unit}</p></div>)}
              </div>
              <div className="py-6"><p className="text-[10px] font-semibold tracking-[0.18em] text-[#6f837e]">BEFORE LANDING · 2 OF 7</p><div className="mt-5 flex items-center justify-between text-sm"><span className="text-[#a8bbb6]">✓ Fuel selector valve</span><span className="font-mono text-[#b8ff58]">BOTH</span></div><div className="mt-5 rounded-xl border border-[#b8ff58]/20 bg-[#b8ff58]/6 p-4"><div className="flex items-center gap-3"><Volume2 className="size-5 text-[#b8ff58]" /><span className="text-lg font-medium text-white">Landing gear · DOWN</span></div><p className="mt-2 pl-8 text-xs text-[#8ea29e]">Checked / next / back</p></div></div>
            </div>
          </div>
        </section>
      )}

      {stage === 'import' && (
        <section className="mx-auto max-w-4xl px-5 py-10 md:px-8 md:py-14">
          <div className="border-b border-white/8 pb-7">
            <Badge className="border border-cyan-300/20 bg-cyan-300/8 text-cyan-100">OPENAI VISION · READY FOR API KEY</Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-4xl">Import checklist images</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#8ea29e]">Add clear photos in printed order. SecondSeat will turn them into a structured draft for you to review and edit.</p>
          </div>

          <div className="mt-8 grid gap-7 md:grid-cols-[1fr_.9fr]">
            <div>
              <label htmlFor="import-name" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8ea29e]">Aircraft or checklist name</label>
              <Input id="import-name" value={importName} onChange={(event) => setImportName(event.target.value)} placeholder="e.g. N12345 · Cessna R182" className="mt-2 h-12 border-white/10 bg-[#0c1715] text-white placeholder:text-[#58706a]" />

              <label htmlFor="checklist-images" aria-label="Choose checklist images" className="mt-5 grid min-h-56 cursor-pointer place-items-center rounded-2xl border border-dashed border-white/15 bg-[#0c1715] p-8 text-center transition hover:border-[#b8ff58]/35 hover:bg-[#0f1c19]">
                <span>
                  <span className="mx-auto grid size-12 place-items-center rounded-xl bg-[#b8ff58]/10 text-[#b8ff58]"><Upload className="size-5" /></span>
                  <span className="mt-4 block text-sm font-medium text-white">Choose checklist images</span>
                  <span className="mt-2 block text-xs leading-5 text-[#6f837e]">PNG or JPEG · up to 8 images · 16 MB each</span>
                </span>
              </label>
              <input id="checklist-images" type="file" accept="image/png,image/jpeg" multiple className="sr-only" onChange={(event) => { selectImportFiles(event.target.files); event.target.value = ''; }} />
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0c1715] p-5">
              <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium text-white">Images</h2><span className="font-mono text-xs text-[#6f837e]">{importFiles.length}/8</span></div>
              {importFiles.length ? (
                <div className="mt-4 space-y-2">
                  {importFiles.map((file, index) => (
                    <div key={`${file.name}-${file.size}`} className="flex items-center gap-3 rounded-xl border border-white/8 bg-[#07100f] p-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/5 text-[#8ea29e]"><FileImage className="size-4" /></span>
                      <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-[#c8d4d1]">{index + 1}. {file.name}</p><p className="mt-1 font-mono text-[10px] text-[#58706a]">{(file.size / 1024 / 1024).toFixed(1)} MB</p></div>
                      <button type="button" onClick={() => setImportFiles((current) => current.filter((candidate) => candidate !== file))} aria-label={`Remove ${file.name}`} className="rounded-lg p-2 text-[#6f837e] hover:bg-white/5 hover:text-white"><X className="size-4" /></button>
                    </div>
                  ))}
                </div>
              ) : <div className="grid min-h-52 place-items-center text-center"><div><FileImage className="mx-auto size-7 text-[#40534f]" /><p className="mt-3 text-xs text-[#6f837e]">No images selected</p></div></div>}
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-cyan-300/15 bg-cyan-300/5 px-4 py-3 text-xs leading-5 text-[#a8bbb6]"><strong className="font-medium text-cyan-100">Real extraction pipeline:</strong> original images are sent from the server to GPT-6.1 Terra and validated against the SecondSeat schema. No sample checklist is substituted.</div>
          {importError && <p role="alert" className="mt-4 text-sm text-red-200">{importError}</p>}
          <div className="mt-7 flex flex-col-reverse justify-between gap-3 sm:flex-row"><Button variant="ghost" onClick={() => setStage('upload')} className="h-11 px-4 text-[#8ea29e] hover:bg-white/5 hover:text-white"><ChevronLeft /> Back</Button><Button onClick={extractImportedChecklist} disabled={importing} className="h-11 bg-[#b8ff58] px-5 text-[#07100f] hover:bg-[#c7ff7c]">{importing ? <><Sparkles className="animate-pulse" /> Extracting…</> : <><Sparkles /> Extract draft <ArrowRight /></>}</Button></div>
        </section>
      )}

      {stage === 'review' && (
        <section className="mx-auto max-w-5xl px-5 py-10 md:px-8 md:py-14">
          <div className="flex flex-col justify-between gap-5 border-b border-white/8 pb-8 md:flex-row md:items-end"><div><h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">Review checklist library</h1><p className="mt-3 text-sm text-[#8ea29e]">Verify against the approved aircraft documents before use.</p></div><div className="text-right"><div className="flex flex-wrap justify-end gap-2"><Badge className="border border-[#b8ff58]/20 bg-[#b8ff58]/8 text-[#b8ff58]">{aircraftName}</Badge>{nightMode && aircraftName.includes('R182') && <Badge className="border border-indigo-300/20 bg-indigo-300/8 text-indigo-200">NIGHT OPS</Badge>}</div><p className="mt-2 text-[10px] uppercase tracking-wider text-[#6f837e]">{checklist.length} checklists · {checklist.reduce((sum, section) => sum + section.items.length, 0)} items</p>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="mt-2 block text-[10px] uppercase tracking-wider text-[#8ea29e] underline decoration-white/20 underline-offset-4 hover:text-white">{sourceLabel} ↗</a> : <p className="mt-2 text-[10px] uppercase tracking-wider text-[#6f837e]">{sourceLabel}</p>}</div></div>
          {importReviewNote && <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/6 p-4"><div className="flex flex-wrap items-center gap-2"><Badge className="border border-amber-300/20 bg-amber-300/10 text-amber-100">AI-EXTRACTED DRAFT</Badge><strong className="text-sm font-medium text-white">Pilot review required</strong></div><p className="mt-2 text-xs leading-5 text-[#a8bbb6]">{importReviewNote} The JSON schema passed, but that does not prove the checklist content is correct.</p>{importWarnings.length > 0 && <ul className="mt-3 space-y-1 pl-4 text-xs text-amber-100">{importWarnings.map((warning) => <li key={warning} className="list-disc">{warning}</li>)}</ul>}</div>}
          <Tabs value={reviewCategory} onValueChange={(value) => setReviewCategory(value as ChecklistCategory)} className="mt-8">
            <TabsList className="h-11 w-full justify-start rounded-xl border border-white/10 bg-[#0c1715] p-1 sm:w-fit">
              <TabsTrigger value="normal" className="h-9 px-4 data-active:bg-[#b8ff58] data-active:text-[#07100f]">Normal · {normalCount}</TabsTrigger>
              <TabsTrigger value="emergency" disabled={!emergencyCount} className="h-9 px-4 data-active:bg-red-300 data-active:text-[#160706]">Emergency · {emergencyCount}</TabsTrigger>
            </TabsList>
            {(['normal', 'emergency'] as const).map((category) => (
              <TabsContent key={category} value={category} className="mt-5 space-y-3">
                {checklist.filter((section) => section.category === category).map((section) => (
                  <details key={section.id} className={`group overflow-hidden rounded-2xl border bg-[#0c1715] ${section.category === 'emergency' ? 'border-red-300/15' : 'border-white/10'}`}>
                    <summary aria-label={`Review ${section.name}`} className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 marker:hidden">
                      <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold tracking-[0.1em] text-white">{section.name}</h2>{section.sourceKind === 'prototype-supplement' && <Badge className="border border-amber-300/20 bg-amber-300/8 text-amber-200">PILOT REVIEW</Badge>}</div><p className="mt-1 text-xs text-[#6f837e]">{section.group} · POH {section.sourcePage}{section.sourceKind === 'poh-amplified' ? ' · amplified procedure' : ''}</p></div>
                      <div className="shrink-0 text-right"><p className="font-mono text-sm text-white">{section.items.length}</p><p className="text-[9px] uppercase tracking-wider text-[#58706a]">items</p></div>
                    </summary>
                    <div className="space-y-4 border-t border-white/8 p-5">
                      {section.items.map((item, index) => <div key={item.id} className="grid grid-cols-[24px_1fr] gap-3 border-t border-white/8 pt-4 first:border-0 first:pt-0"><span className="pt-2 font-mono text-xs text-[#58706a]">{String(index + 1).padStart(2, '0')}</span><div className="grid gap-2 sm:grid-cols-2"><label htmlFor={`${section.id}-${item.id}-challenge`} className="text-[10px] uppercase tracking-[0.12em] text-[#6f837e]">Item<Input id={`${section.id}-${item.id}-challenge`} value={item.challenge} onChange={(event) => updateItem(section.id, item.id, 'challenge', event.target.value)} className="mt-1 h-10 border-white/10 bg-[#07100f] text-white" /></label><label htmlFor={`${section.id}-${item.id}-expected`} className="text-[10px] uppercase tracking-[0.12em] text-[#6f837e]">Action / required state · optional<Input id={`${section.id}-${item.id}-expected`} value={item.expected} placeholder="Leave blank for a standalone instruction" onChange={(event) => updateItem(section.id, item.id, 'expected', event.target.value)} className="mt-1 h-10 border-white/10 bg-[#07100f] font-mono text-[#b8ff58]" /></label></div></div>)}
                    </div>
                  </details>
                ))}
              </TabsContent>
            ))}
          </Tabs>
          <div className="mt-7 rounded-2xl border border-amber-300/15 bg-amber-300/5 p-5"><div className="flex items-start gap-3 text-sm leading-6 text-[#c8d4d1]"><Checkbox id="pilot-review" checked={reviewed} onCheckedChange={(value) => setReviewed(Boolean(value))} className="mt-1 border-white/20 data-checked:border-[#b8ff58] data-checked:bg-[#b8ff58] data-checked:text-[#07100f]" /><label htmlFor="pilot-review" className="cursor-pointer"><strong className="font-medium text-white">I reviewed this checklist against its source.</strong><br /><span className="text-[#8ea29e]">SecondSeat records verbal confirmation only; it cannot verify the aircraft’s physical configuration.</span></label></div></div>
          {voiceError && <div role="alert" className="mt-5 rounded-xl border border-red-300/20 bg-red-300/6 px-4 py-3 text-xs leading-5 text-red-100"><strong className="font-medium">Kokoro could not finish:</strong> {voiceError}</div>}
          {saveMessage && <output className="mt-4 block text-sm text-cyan-100">{saveMessage}</output>}
          <div className="mt-6 flex flex-col-reverse justify-between gap-3 sm:flex-row"><Button variant="ghost" className="h-11 px-4 text-[#8ea29e] hover:bg-white/5 hover:text-white" onClick={() => setStage(importReviewNote ? 'import' : 'upload')}><ChevronLeft /> Back</Button><div className="flex flex-col gap-2 sm:flex-row">{importedProfile && <Button variant="outline" disabled={!reviewed || savingChecklist} onClick={saveImportedChecklist} className="h-11 border-white/10 bg-transparent text-cyan-100 hover:bg-cyan-300/10 hover:text-white">{savingChecklist ? <><Sparkles className="animate-pulse" /> Saving…</> : <><FileImage /> Save JSON</>}</Button>}<Button disabled={!reviewed || voicePreparing} onClick={prepareVoiceAndStartFlight} className="h-11 bg-[#b8ff58] px-5 text-[#07100f] hover:bg-[#c7ff7c]">{voicePreparing ? <><Sparkles className="animate-pulse" /> Generating Kokoro voice for {aircraftName}…</> : <><ShieldCheck /> Confirm, generate voice & start <ArrowRight /></>}</Button></div></div>
        </section>
      )}

      {stage === 'flight' && (
        <section className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-3"><span className="flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-[#b8ff58]"><span className="size-2 rounded-full bg-[#b8ff58] shadow-[0_0_12px_#b8ff58]" /> DEMO FLIGHT</span>{gpsAutoDetect && <Badge className="border border-cyan-300/20 bg-cyan-300/8 text-cyan-200"><Satellite className="size-3" /> GPS {gpsPlaying ? 'PLAYING' : 'PAUSED'}</Badge>}<span className="text-xs text-[#58706a]">{aircraftName}</span></div><Button variant="ghost" onClick={() => { setGpsAutoDetect(false); setGpsPlaying(false); setStage('review'); }} className="text-[#8ea29e] hover:bg-white/5 hover:text-white"><RotateCcw /> Return to review</Button></div>
          <div className="grid min-h-[650px] overflow-hidden rounded-3xl border border-white/10 bg-[#08110f] shadow-2xl shadow-black/25 lg:grid-cols-[.78fr_1.22fr]">
            <div className="border-b border-white/10 bg-[#0c1715] p-6 lg:border-b-0 lg:border-r lg:p-8">
              <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold tracking-[0.2em] text-[#6f837e]">{gpsAutoDetect ? 'SIMULATED GPS STREAM' : 'SIMULATED FLIGHT DATA'}</p><h2 className="mt-2 text-2xl font-semibold text-white">{phase.name}</h2></div>{gpsAutoDetect ? <Satellite className="size-8 text-cyan-200" /> : <Plane className="size-8 -rotate-12 text-[#b8ff58]" />}</div>
              <div className="mt-8 grid grid-cols-3 gap-3 lg:grid-cols-1">{[['ALTITUDE', telemetry.altitude.toLocaleString(), 'FT'], ['GROUND SPEED', telemetry.speed, 'KT'], ['VERTICAL SPEED', telemetry.vertical > 0 ? `+${telemetry.vertical}` : telemetry.vertical, 'FPM']].map(([label, value, unit]) => <div key={label} className="border-t border-white/8 py-5 lg:flex lg:items-end lg:justify-between"><p className="text-[9px] tracking-[0.14em] text-[#6f837e]">{label}</p><div><span className="font-mono text-2xl text-white lg:text-4xl">{value}</span><span className="ml-2 font-mono text-[10px] text-[#6f837e]">{unit}</span></div></div>)}</div>
              <div className={`mt-5 rounded-xl border p-4 ${gpsAutoDetect ? 'border-cyan-300/20 bg-cyan-300/6' : 'border-white/8 bg-[#07100f]'}`}><div className="flex items-center justify-between gap-3"><div><p className="text-[9px] font-semibold tracking-[0.16em] text-[#6f837e]">FLIGHT TIMELINE</p><p className={`mt-1 text-sm font-medium ${gpsAutoDetect ? 'text-cyan-100' : 'text-[#a8bbb6]'}`}>{gpsAutoDetect ? `${gpsDetection.phase} · ${gpsDetection.aglFt} FT AGL` : `${Math.round(DEMO_FLIGHT.durationSeconds / 60)}-minute simulated flight`}</p></div><Button type="button" onClick={toggleGpsDemo} variant="outline" className={`h-10 border-white/10 bg-transparent ${gpsAutoDetect ? 'text-cyan-100 hover:bg-cyan-300/10 hover:text-white' : 'text-[#b8ff58] hover:bg-[#b8ff58]/10 hover:text-[#b8ff58]'}`}>{gpsAutoDetect && gpsPlaying ? <><Pause /> Pause</> : <><Play /> {gpsAutoDetect ? 'Play' : 'Start flight'}</>}</Button></div><div className="mt-4"><div className="mb-2 flex items-center justify-between gap-3"><span className="text-xs font-medium text-white">{timelineSegment.label}</span><span className="font-mono text-[10px] text-cyan-100">{formatFlightTime(timelineSecond)} / {formatFlightTime(DEMO_FLIGHT.durationSeconds)}</span></div><Slider aria-label="Complete flight timeline" min={0} max={DEMO_FLIGHT.durationSeconds} step={1} value={[timelineSecond]} onValueChange={(value) => previewFlightTimeline(firstSliderValue(value))} onValueCommitted={(value) => commitFlightTimeline(firstSliderValue(value))} className="[&_[data-slot=slider-range]]:bg-cyan-300" /><div className="mt-2 flex justify-between text-[9px] uppercase tracking-wider text-[#58706a]"><span>Parked</span><span>Hold short</span><span>Climb</span><span>Cruise</span><span>Approach</span><span>Parked</span></div></div></div>
              <div className="mt-7"><p className="mb-3 text-[10px] tracking-[0.14em] text-[#6f837e]">FLIGHT PHASE</p><div className="flex flex-wrap gap-2">{PHASES.map((candidate, index) => <button key={candidate.name} onClick={() => { setGpsAutoDetect(false); setGpsPlaying(false); moveToPhase(index); }} className={`rounded-lg border px-2.5 py-2 text-[10px] font-semibold tracking-[0.08em] transition ${index === phaseIndex ? 'border-[#b8ff58]/35 bg-[#b8ff58]/10 text-[#b8ff58]' : 'border-white/8 text-[#6f837e] hover:border-white/20 hover:text-white'}`}>{candidate.name}</button>)}</div></div>
              <div className="mt-7"><p className="mb-3 text-[10px] tracking-[0.14em] text-[#6f837e]">CHECKLIST LIBRARY</p><Select value={activeSectionId ?? undefined} onValueChange={(value) => { if (value) activateChecklist(value); }}><SelectTrigger className="h-11 w-full border-white/10 bg-[#07100f] text-[#a8bbb6]"><SelectValue placeholder="Select any checklist" /></SelectTrigger><SelectContent className="max-h-96 border-white/10 bg-[#0c1715] text-white"><SelectGroup><SelectLabel>Normal procedures</SelectLabel>{checklist.filter((section) => section.category === 'normal').map((section) => <SelectItem key={section.id} value={section.id}>{section.name}</SelectItem>)}</SelectGroup>{emergencyCount > 0 && <SelectGroup><SelectLabel className="text-red-200">Emergency procedures</SelectLabel>{checklist.filter((section) => section.category === 'emergency').map((section) => <SelectItem key={section.id} value={section.id}>{section.name}</SelectItem>)}</SelectGroup>}</SelectContent></Select></div>
              <div className="mt-8 flex gap-2"><Button variant="outline" disabled={phaseIndex === 0} onClick={() => { setGpsAutoDetect(false); setGpsPlaying(false); moveToPhase(phaseIndex - 1); }} className="h-10 flex-1 border-white/10 bg-transparent text-[#a8bbb6] hover:bg-white/5 hover:text-white"><ChevronLeft /> Previous</Button><Button disabled={phaseIndex === PHASES.length - 1} onClick={() => { setGpsAutoDetect(false); setGpsPlaying(false); moveToPhase(phaseIndex + 1); }} className="h-10 flex-1 bg-[#b8ff58] text-[#07100f] hover:bg-[#c7ff7c]">Next <ChevronRight /></Button></div>
            </div>

            <div className="flex flex-col p-6 lg:p-8">
              {holdShortGateOpen && <div className="mb-5 rounded-2xl border border-amber-300/25 bg-amber-300/7 p-4" role="alert"><div className="flex items-start gap-3"><span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-amber-300/10 text-amber-200"><Plane className="size-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-white">{holdShortStatus === 'ready' ? 'Ready for takeoff' : 'Hold short'}</h3>{runupComplete && <Badge className="border border-amber-300/20 bg-amber-300/10 text-amber-100">RUN-UP COMPLETE</Badge>}</div><p className="mt-1 text-xs text-[#a8bbb6]">{holdShortStatus === 'runup' ? 'Complete the Engine Run-up checklist.' : holdShortStatus === 'before-takeoff' ? 'Complete the Before Takeoff checklist.' : holdShortStatus === 'ready' ? 'The demo remains paused until you line up.' : holdShortChoiceBlocked ? 'Finish the current prompt first.' : 'Choose Run-up, or continue to Before Takeoff.'}</p></div></div>{holdShortStatus === 'ready' ? <div className="mt-4 pl-12"><Button type="button" onClick={releaseHoldShort} className="h-10 bg-amber-200 text-[#171006] hover:bg-amber-100"><Plane /> Line up & continue</Button></div> : holdShortStatus === 'decision' && <div className="mt-4 flex flex-wrap gap-2 pl-12"><Button type="button" onClick={() => chooseHoldShort('runup')} disabled={holdShortChoiceBlocked} variant="outline" className="h-10 border-amber-300/20 bg-transparent text-amber-100 hover:bg-amber-300/10 hover:text-white">Run-up</Button><Button type="button" onClick={() => chooseHoldShort('takeoff')} disabled={holdShortChoiceBlocked} className="h-10 bg-amber-200 text-[#171006] hover:bg-amber-100">Ready for takeoff</Button></div>}</div>}
              {checklistSuggestion && <div className="mb-5 rounded-2xl border border-cyan-300/25 bg-cyan-300/7 p-4 shadow-lg shadow-black/10" role="alert"><div className="flex items-start gap-3"><span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-cyan-300/10 text-cyan-200"><Satellite className="size-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-white">{checklistSuggestion.phase} detected · Start {checklistSuggestion.sectionName}?</h3>{checklistSuggestions.length > 1 && <Badge className="border border-cyan-300/20 bg-cyan-300/10 text-cyan-100">+{checklistSuggestions.length - 1} waiting</Badge>}</div>{activeChecklistRunning && <p className="mt-1 text-xs leading-5 text-[#a8bbb6]">Current checklist continues; this one will be queued.</p>}</div></div><div className="mt-4 flex flex-wrap gap-2 pl-12"><Button type="button" onClick={dismissChecklistSuggestion} variant="ghost" className="h-10 text-[#8ea29e] hover:bg-white/5 hover:text-white">Not now</Button><Button type="button" onClick={confirmChecklistSuggestion} className="h-10 bg-cyan-200 text-[#061313] hover:bg-cyan-100"><Check /> {activeChecklistRunning ? 'Confirm & queue' : 'Yes, start checklist'}</Button></div></div>}
              {!checklistSuggestion && queuedChecklists.length > 0 && <div className="mb-5 rounded-xl border border-amber-300/15 bg-amber-300/6 px-4 py-3 text-sm text-amber-100">{queuedChecklists.length} checklist{queuedChecklists.length > 1 ? 's' : ''} queued · starts next</div>}
              {!activeSection ? <div className="grid flex-1 place-items-center text-center"><div className="max-w-sm"><span className="mx-auto grid size-16 place-items-center rounded-2xl border border-white/10 bg-white/4 text-[#6f837e]"><Headphones className="size-7" /></span><h2 className="mt-5 text-2xl font-semibold text-white">SecondSeat is standing by</h2><p className="mt-3 text-sm leading-6 text-[#8ea29e]">GPS suggestions wait for confirmation. Or choose a checklist manually.</p></div></div> : (
                <><div className="flex items-start justify-between gap-4 border-b border-white/8 pb-5"><h2 className="text-2xl font-semibold text-white">{activeSection.name}</h2><div className="text-right"><p className="font-mono text-sm text-white">{confirmedCount}/{activeSection.items.length}</p><p className="text-[10px] text-[#6f837e]">{progress}% COMPLETE</p></div></div><div className="mt-6 h-1 overflow-hidden rounded-full bg-white/6"><div className="h-full bg-[#b8ff58] transition-all duration-500" style={{ width: `${progress}%` }} /></div>
                <div className="mt-7 space-y-3">{activeSection.items.map((item, index) => { const isCurrent = index === itemIndex && !isComplete; return <div key={item.id} className={`rounded-xl border p-4 transition ${isCurrent ? 'border-[#b8ff58]/25 bg-[#b8ff58]/6' : item.status === 'confirmed' ? 'border-white/6 bg-white/[.025]' : 'border-white/6'}`}><div className="flex items-center gap-3"><span className={`grid size-7 shrink-0 place-items-center rounded-full border ${item.status === 'confirmed' ? 'border-[#b8ff58]/30 bg-[#b8ff58]/12 text-[#b8ff58]' : 'border-white/10 text-[#58706a]'}`}>{item.status === 'confirmed' ? <Check className="size-4" /> : <span className="font-mono text-[10px]">{index + 1}</span>}</span><div className="min-w-0 flex-1"><p className={`text-sm ${isCurrent ? 'font-medium text-white' : 'text-[#a8bbb6]'}`}>{item.challenge}</p>{isCurrent && item.expected.trim() && <p className="mt-1 font-mono text-sm text-[#b8ff58]">{item.expected}</p>}{item.status === 'confirmed' && <p className="mt-1 font-mono text-xs text-[#b8ff58]">{item.response}</p>}</div>{isCurrent && <button onClick={() => speak(instructionFor(item), startListening)} className="rounded-lg p-2 text-[#b8ff58] hover:bg-[#b8ff58]/10" aria-label={`Repeat ${item.challenge} instruction`}><Volume2 className="size-5" /></button>}</div></div>; })}</div>
                <div className="mt-auto pt-6">{isComplete ? <div className="rounded-2xl border border-[#b8ff58]/25 bg-[#b8ff58]/8 p-6 text-center"><span className="mx-auto grid size-12 place-items-center rounded-full bg-[#b8ff58] text-[#07100f]"><Check className="size-6" /></span><h3 className="mt-4 text-xl font-semibold text-white">{activeSection.name} checklist complete</h3></div> : <div><div className="mb-3 flex items-center gap-2 text-sm text-[#a8bbb6]"><Volume2 className="size-4 text-[#b8ff58]" /><span><strong className="font-medium text-white">{currentItem?.challenge}</strong>{currentItem?.expected.trim() ? <> · <strong className="font-mono text-[#b8ff58]">{currentItem.expected}</strong></> : null}</span></div><div className="flex gap-2"><Button type="button" aria-label="Listen for checklist command" title={speechInputSupported ? 'Say checked, next, or back' : 'Speech input is unavailable in this browser'} onClick={startListening} disabled={!speechInputSupported || listening} className={`h-14 w-14 shrink-0 border ${listening ? 'animate-pulse border-red-300/40 bg-red-400/15 text-red-200' : 'border-[#b8ff58]/25 bg-[#b8ff58]/10 text-[#b8ff58] hover:bg-[#b8ff58]/20'}`}><Mic /></Button><Button type="button" onClick={advanceFromButton} className="h-14 flex-1 bg-[#b8ff58] text-base font-semibold text-[#07100f] hover:bg-[#c7ff7c]">{listening ? 'Stop listening · Next' : 'Checked · Next'} <ArrowRight /></Button></div><p className="mt-2 text-[10px] text-[#58706a]">{speechInputSupported ? (listening ? 'Listening… or tap Next to continue immediately.' : 'Auto-listens after each prompt · checked / next / back') : 'Tap to continue.'}</p></div>}</div></>
              )}
            </div>
          </div>
          <p aria-live="polite" className="mt-4 text-center text-xs text-[#6f837e]">{notice}</p>
        </section>
      )}

      <footer className="border-t border-white/8 bg-[#07100f] px-5 py-4 text-center text-[11px] leading-5 text-[#6f837e]">Demo only — verify against the aircraft’s approved POH/AFM and checklist.</footer>
    </main>
  );
}
