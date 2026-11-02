import { loadAircraftProfile, type AircraftProfile } from '@/lib/checklist-schema';

export type ChecklistExtractionResult = {
  profile: AircraftProfile;
  model: string;
  warnings: string[];
  reviewRequired: true;
};

export async function extractChecklistImages(displayName: string, images: File[], apiKey?: string): Promise<ChecklistExtractionResult> {
  const formData = new FormData();
  formData.set('displayName', displayName);
  if (apiKey?.trim()) formData.set('apiKey', apiKey.trim());
  for (const image of images) formData.append('images', image);

  const response = await fetch('/api/checklists/extract', { method: 'POST', body: formData });
  const payload = await response.json().catch(() => null) as ({ error?: string } & Partial<ChecklistExtractionResult>) | null;
  if (response.status === 413) throw new Error('The upload exceeds the web server’s 160 MB limit. Try fewer images at a time.');
  if (!response.ok) throw new Error(payload?.error || 'Checklist extraction failed.');
  if (!payload?.profile || !payload.model || !Array.isArray(payload.warnings)) {
    throw new Error('The extraction service returned an incomplete response.');
  }

  return {
    profile: loadAircraftProfile(payload.profile),
    model: payload.model,
    warnings: payload.warnings,
    reviewRequired: true,
  };
}
