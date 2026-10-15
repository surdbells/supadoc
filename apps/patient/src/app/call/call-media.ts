import AgoraRTC, { ICameraVideoTrack, IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';
import { deviceProblem, type DeviceProblem } from './call-helpers';

/**
 * Opening the camera and microphone for the patient's call screens (the
 * signed-in consultation and the join-link page) without one missing device
 * sinking the other.
 */

/** What {@link openLocalMedia} managed to open, and why the rest didn't. */
export interface LocalMedia {
  mic: IMicrophoneAudioTrack | null;
  cam: ICameraVideoTrack | null;
  micProblem: DeviceProblem | null;
  camProblem: DeviceProblem | null;
}

/**
 * Open the microphone and/or camera. Both together first (one browser
 * prompt); if that fails, each on its own, so a missing or blocked camera
 * still leaves an audio-only call (and the other way round). A remembered
 * device that is gone falls back to the default one.
 */
export async function openLocalMedia(want: {
  audio: boolean;
  video: boolean;
  microphoneId?: string;
  cameraId?: string;
}): Promise<LocalMedia> {
  const out: LocalMedia = { mic: null, cam: null, micProblem: null, camProblem: null };
  const micConfig = want.microphoneId ? { microphoneId: want.microphoneId } : undefined;
  const camConfig = want.cameraId ? { cameraId: want.cameraId } : undefined;
  if (want.audio && want.video) {
    try {
      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks(micConfig, camConfig);
      return { mic, cam, micProblem: null, camProblem: null };
    } catch {
      /* find out which one failed, below */
    }
  }
  if (want.audio) {
    try {
      out.mic = await AgoraRTC.createMicrophoneAudioTrack(micConfig);
    } catch (err) {
      out.micProblem = deviceProblem(err);
      if (micConfig && out.micProblem === 'missing') {
        try {
          out.mic = await AgoraRTC.createMicrophoneAudioTrack();
          out.micProblem = null;
        } catch (again) {
          out.micProblem = deviceProblem(again);
        }
      }
    }
  }
  if (want.video) {
    try {
      out.cam = await AgoraRTC.createCameraVideoTrack(camConfig);
    } catch (err) {
      out.camProblem = deviceProblem(err);
      if (camConfig && out.camProblem === 'missing') {
        try {
          out.cam = await AgoraRTC.createCameraVideoTrack();
          out.camProblem = null;
        } catch (again) {
          out.camProblem = deviceProblem(again);
        }
      }
    }
  }
  return out;
}
