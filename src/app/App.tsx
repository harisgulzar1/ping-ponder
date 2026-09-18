"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import { RobotAvatar } from "./components/RobotAvatar";
import BottomToolbar from "./components/BottomToolbar";
import ConversationStage from "./components/ConversationStage";
import LatencyPanel from "./components/LatencyPanel";

// Types
import { SessionStatus } from "@/app/types";
import type { RealtimeAgent } from '@openai/agents/realtime';

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useRealtimeSession } from "./hooks/useRealtimeSession";
import { createModerationGuardrail } from "@/app/agentConfigs/guardrails";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import { customerServiceRetailScenario } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorScenario } from "@/app/agentConfigs/chatSupervisor";
import { travelPlanningScenario } from "@/app/agentConfigs/TravelPlanningAgent";
import { fastTravelPlanningScenario } from "@/app/agentConfigs/TravelPlanningAgent/fast";
import { customerServiceRetailCompanyName } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorCompanyName } from "@/app/agentConfigs/chatSupervisor";
import { travelPlanningCompanyName } from "@/app/agentConfigs/TravelPlanningAgent";
import { fastTravelPlanningCompanyName } from "@/app/agentConfigs/TravelPlanningAgent/fast";
import { simpleHandoffScenario } from "@/app/agentConfigs/simpleHandoff";

// Map used by connect logic for scenarios defined via the SDK.
const sdkScenarioMap: Record<string, RealtimeAgent[]> = {
  simpleHandoff: simpleHandoffScenario,
  customerServiceRetail: customerServiceRetailScenario,
  chatSupervisor: chatSupervisorScenario,
  travelPlanning: travelPlanningScenario,
  fastTravelPlanning: fastTravelPlanningScenario,
};

import useAudioDownload from "./hooks/useAudioDownload";
import { useHandleSessionHistory } from "./hooks/useHandleSessionHistory";
import useTurnLatency from "./hooks/useTurnLatency";
import { getStoredItem, setStoredItem } from "./lib/safeStorage";

/** Scenario keys that take part in the sequential-vs-parallel comparison. */
const TRAVEL_SCENARIOS = new Set(["travelPlanning", "fastTravelPlanning"]);

function App() {
  const searchParams = useSearchParams()!;

  // ---------------------------------------------------------------------
  // Codec selector – lets you toggle between wide-band Opus (48 kHz)
  // and narrow-band PCMU/PCMA (8 kHz) to hear what the agent sounds like on
  // a traditional phone line and to validate ASR / VAD behaviour under that
  // constraint.
  //
  // We read the `?codec=` query-param and rely on the `changePeerConnection`
  // hook (configured in `useRealtimeSession`) to set the preferred codec
  // before the offer/answer negotiation.
  // ---------------------------------------------------------------------
  const urlCodec = searchParams.get("codec") || "opus";

  // Which scenario (and therefore which pipeline) is active. Resolved once here
  // so the session context, the metrics and the UI all agree on it.
  const scenarioKey = searchParams.get("agentConfig") || "default";
  const isTravelScenario = TRAVEL_SCENARIOS.has(scenarioKey);

  // Agents SDK doesn't currently support codec selection so it is now forced 
  // via global codecPatch at module load 

  const {
    addTranscriptMessage,
    addTranscriptBreadcrumb,
  } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [sessionId, setSessionId] = useState<string>("");

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    RealtimeAgent[] | null
  >(null);

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  // Ref to identify whether the latest agent switch came from an automatic handoff
  const handoffTriggeredRef = useRef(false);

  const sdkAudioElement = React.useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.style.display = 'none';
    // Avoid duplicate playback if other audio nodes linger from previous sessions
    el.dataset.source = 'realtime-sdk-output';
    document.body.appendChild(el);
    return el;
  }, []);

  const cleanSdkAudioElements = useCallback(() => {
    if (typeof document === "undefined") return;

    const teardownAudio = (node: HTMLAudioElement) => {
      if (node.srcObject instanceof MediaStream) {
        node.srcObject.getTracks().forEach((t) => t.stop());
        node.srcObject = null;
      }
      node.pause();
      node.load();
    };

    const audioNodes = Array.from(document.querySelectorAll<HTMLAudioElement>("audio"));

    audioNodes.forEach((node) => {
      // Keep the memoized SDK element but ensure it's clean before reuse.
      if (sdkAudioElement && node === sdkAudioElement) {
        teardownAudio(node);
        return;
      }

      teardownAudio(node);
      node.remove();
    });
  }, [sdkAudioElement]);

  // Attach SDK audio element once it exists (after first render in browser)
  useEffect(() => {
    if (sdkAudioElement && !audioElementRef.current) {
      audioElementRef.current = sdkAudioElement;
    }
  }, [sdkAudioElement]);

  const handleAvatarEvents = useCallback(
    (event: any) => {
      switch (event.type) {
        case "input_audio_buffer.speech_started":
          setAvatarState("listening");
          setIsAssistantSpeaking(false);
          setIsRecording(true);
          break;
        case "input_audio_buffer.speech_stopped":
          setAvatarState("thinking");
          setIsRecording(false);
          break;
        case "conversation.item.input_audio_transcription.completed":
          setAvatarState((prev) => (prev === "listening" ? "thinking" : prev));
          break;
        case "response.audio.delta":
        case "response.output_audio.started":
        case "response.output_audio.delta":
          setAvatarState("speaking");
          setIsAssistantSpeaking(true);
          break;
        case "response.audio_transcript.done":
        case "response.output_audio.done":
        case "response.done": {
          const audioIsPlaying =
            sdkAudioElement &&
            sdkAudioElement.dataset.source === "realtime-sdk-output" &&
            !sdkAudioElement.paused;

          if (audioIsPlaying) {
            // Keep the avatar in the speaking state until playback actually stops.
            setAvatarState("speaking");
            setIsAssistantSpeaking(true);
          } else {
            setAvatarState("idle");
            setIsAssistantSpeaking(false);
          }
          break;
        }
      }
    },
    [sdkAudioElement],
  );

  // Measures how long the user waits: time to first audio, and -- the headline
  // number for the sequential-vs-parallel comparison -- time until the answer
  // is finished. Both span WebRTC transport events, so they can only be taken
  // in the browser; they are posted to /api/metrics from the hook.
  const {
    handleTransportEvent: recordTurnLatency,
    markTextTurnStart,
    latest: latestTurnLatency,
  } = useTurnLatency({ sessionId, scenario: scenarioKey });

  const {
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    interrupt,
    mute,
  } = useRealtimeSession({
    onConnectionChange: (s) => setSessionStatus(s as SessionStatus),
    onAgentHandoff: (agentName: string) => {
      handoffTriggeredRef.current = true;
      setSelectedAgentName(agentName);
    },
    onTransportEvent: (event) => {
      handleAvatarEvents(event);
      if (isTravelScenario) recordTurnLatency(event);
    },
  });

  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isAvatarVisible, setIsAvatarVisible] = useState<boolean>(true);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(
    () => {
      const stored = getStoredItem('audioPlaybackEnabled');
      return stored ? stored === 'true' : true;
    },
  );

  const [avatarState, setAvatarState] = useState<
    "idle" | "listening" | "thinking" | "speaking"
  >("idle");
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);

  useEffect(() => {
    if (sessionId || typeof window === "undefined") return;
    const storedSession = getStoredItem("travelSessionId");
    const id = storedSession || uuidv4();
    setStoredItem("travelSessionId", id);
    setSessionId(id);
  }, [sessionId]);

  // Reset planning state on first load of a session AND whenever the scenario
  // changes. Without the scenario check, switching from the sequential arm to
  // the parallel one inherited a fully populated plan, so the parallel agent had
  // nothing left to do and the comparison was meaningless.
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    if (!isTravelScenario) return;

    const scenarioKeyName = `travelStateScenario_${sessionId}`;
    if (getStoredItem(scenarioKeyName) === scenarioKey) return;

    const resetStateForScenario = async () => {
      try {
        await fetch("/api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, action: "resetState" }),
        });
        setStoredItem(scenarioKeyName, scenarioKey);
      } catch (err) {
        console.error("Failed to reset server state for scenario", err);
      }
    };

    void resetStateForScenario();
  }, [sessionId, scenarioKey, isTravelScenario]);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    try {
      sendEvent(eventObj);
      logClientEvent(eventObj, eventNameSuffix);
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }
  };

  useHandleSessionHistory();

  useEffect(() => {
    if (!sessionId) return;

    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams, sessionId]);

  useEffect(() => {
    if (sessionId && selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName, sessionId]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(!handoffTriggeredRef.current);
      // Reset flag after handling so subsequent effects behave normally
      handoffTriggeredRef.current = false;
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  const fetchEphemeralKey = async (): Promise<
    { key: string; model?: string } | null
  > => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      // The route reports the upstream OpenAI error verbatim, so print it
      // rather than the generic message that used to hide the cause.
      console.error(
        data.error ?? "No ephemeral key provided by the server",
        data.attempts ?? data,
      );
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return { key: data.client_secret.value, model: data.model };
  };

  const connectToRealtime = async () => {
    if (!sessionId) return;
    // Same value the component resolved at the top; no need to re-read the URL.
    const agentSetKey = scenarioKey;
    if (sdkScenarioMap[agentSetKey]) {
      if (sessionStatus !== "DISCONNECTED") return;
      setSessionStatus("CONNECTING");

      // Make sure any previous tracks on the shared audio element are stopped before reuse
      cleanSdkAudioElements();

      try {
        const ephemeral = await fetchEphemeralKey();
        if (!ephemeral) return;

        // Ensure the selectedAgentName is first so that it becomes the root
        const reorderedAgents = [...sdkScenarioMap[agentSetKey]];
        const idx = reorderedAgents.findIndex((a) => a.name === selectedAgentName);
        if (idx > 0) {
          const [agent] = reorderedAgents.splice(idx, 1);
          reorderedAgents.unshift(agent);
        }

        // Previously this tested 'fastTravelPlanning' first and returned the
        // retail company name, making the later fastTravelPlanning branch dead
        // and mislabelling the parallel scenario's guardrail.
        const companyNameByScenario: Record<string, string> = {
          travelPlanning: travelPlanningCompanyName,
          fastTravelPlanning: fastTravelPlanningCompanyName,
          customerServiceRetail: customerServiceRetailCompanyName,
          chatSupervisor: chatSupervisorCompanyName,
        };
        const companyName =
          companyNameByScenario[agentSetKey] ?? chatSupervisorCompanyName;
        const guardrail = createModerationGuardrail(companyName);

        await connect({
          getEphemeralKey: async () => ephemeral.key,
          // The key is minted for a specific model; connecting with a
          // different one is a mismatch waiting to happen, so the server's
          // choice is the single source of truth.
          model: ephemeral.model,
          initialAgents: reorderedAgents,
          audioElement: sdkAudioElement,
          outputGuardrails: [guardrail],
          extraContext: {
            addTranscriptBreadcrumb,
            sessionId,
            // Lets tools attribute their metrics to the right pipeline without
            // having to sniff the URL.
            scenario: agentSetKey,
          },
        });
      } catch (err) {
        console.error("Error connecting via SDK:", err);
        setSessionStatus("DISCONNECTED");
      }
      return;
    }
  };

  const disconnectFromRealtime = () => {
    disconnect();
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);

    cleanSdkAudioElements();
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent({
      type: 'conversation.item.create',
      item: {
        id,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    sendClientEvent({ type: 'response.create' }, '(simulated user text message)');
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    // Reflect Push-to-Talk UI state by (de)activating server VAD on the
    // backend. The Realtime SDK supports live session updates via the
    // `session.update` event.
    const turnDetection = isPTTActive
      ? null
      : {
          type: 'server_vad',
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    sendEvent({
      type: 'session.update',
      session: {
        turn_detection: turnDetection,
      },
    });

    // Send an initial 'hi' message to trigger the agent to greet the user
    if (shouldTriggerResponse) {
      sendSimulatedUserMessage('hi');
    }
    return;
  }

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    interrupt();

    // A typed turn produces no speech_stopped event, so start the clock here.
    if (isTravelScenario) markTextTurnStart();

    try {
      sendUserText(userText.trim());
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }

    setUserText("");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== 'CONNECTED') return;
    interrupt();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: 'input_audio_buffer.clear' }, 'clear PTT buffer');

    // No placeholder; we'll rely on server transcript once ready.
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== 'CONNECTED' || !isPTTUserSpeaking)
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: 'input_audio_buffer.commit' }, 'commit PTT');
    sendClientEvent({ type: 'response.create' }, 'trigger response PTT');
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", newAgentConfig);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    // Reconnect session with the newly selected agent as root so that tool
    // execution works correctly.
    disconnectFromRealtime();
    setSelectedAgentName(newAgentName);
    // connectToRealtime will be triggered by effect watching selectedAgentName
  };

  // Because we need a new connection, refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    const storedPushToTalkUI = getStoredItem("pushToTalkUI");
    if (storedPushToTalkUI) {
      setIsPTTActive(storedPushToTalkUI === "true");
    }
    const storedAvatarVisible = getStoredItem("avatarExpanded");
    if (storedAvatarVisible) {
      setIsAvatarVisible(storedAvatarVisible === "true");
    }
    const storedAudioPlaybackEnabled = getStoredItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    setStoredItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    setStoredItem("avatarExpanded", isAvatarVisible.toString());
  }, [isAvatarVisible]);

  useEffect(() => {
    setStoredItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.muted = false;
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        // Mute and pause to avoid brief audio blips before pause takes effect.
        audioElementRef.current.muted = true;
        audioElementRef.current.pause();
      }
    }

    // Toggle server-side audio stream mute so bandwidth is saved when the
    // user disables playback. 
    try {
      mute(!isAudioPlaybackEnabled);
    } catch (err) {
      console.warn('Failed to toggle SDK mute', err);
    }
  }, [isAudioPlaybackEnabled]);

  // Ensure mute state is propagated to transport right after we connect or
  // whenever the SDK client reference becomes available.
  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      try {
        mute(!isAudioPlaybackEnabled);
      } catch (err) {
        console.warn('mute sync after connect failed', err);
      }
    }
  }, [sessionStatus, isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== "CONNECTED") {
      setAvatarState("idle");
      setIsAssistantSpeaking(false);
      setIsRecording(false);
    }
  }, [sessionStatus]);

  useEffect(() => {
    if (!sdkAudioElement) return;

    const handlePlay = () => {
      setAvatarState((prev) => (prev === "listening" ? prev : "speaking"));
      setIsAssistantSpeaking(true);
    };

    const handleStop = () => {
      setIsAssistantSpeaking(false);
      setAvatarState("idle");
    };

    sdkAudioElement.addEventListener("playing", handlePlay);
    sdkAudioElement.addEventListener("pause", handleStop);
    sdkAudioElement.addEventListener("ended", handleStop);

    return () => {
      sdkAudioElement.removeEventListener("playing", handlePlay);
      sdkAudioElement.removeEventListener("pause", handleStop);
      sdkAudioElement.removeEventListener("ended", handleStop);
    };
  }, [sdkAudioElement]);

  // Single source for the active scenario, resolved at the top of the component.
  const agentSetKey = scenarioKey;

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/openai-logomark.svg"
              alt="OpenAI Logo"
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>

        {/* Live readout of the metric the project is about. */}
        {isTravelScenario && (
          <div className="flex items-center gap-2 text-sm font-normal">
            <span
              className={`px-2 py-1 rounded-full text-xs font-medium border ${
                scenarioKey === "fastTravelPlanning"
                  ? "bg-orange-50 text-orange-900 border-orange-200"
                  : "bg-blue-50 text-blue-900 border-blue-200"
              }`}
            >
              {scenarioKey === "fastTravelPlanning"
                ? "parallel pipeline"
                : "sequential pipeline"}
            </span>
            <span
              className="text-gray-600 tabular-nums"
              title="End of your speech to the assistant finishing its answer"
            >
              last answer:{" "}
              {latestTurnLatency
                ? `${(latestTurnLatency.completionMs / 1000).toFixed(2)}s`
                : "--"}
            </span>
          </div>
        )}

        <div className="flex items-center">
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            Scenario
          </label>
          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
            >
              {Object.keys(allAgentSets).map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {agentKey}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                Agent
              </label>
              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                >
                  {selectedAgentConfigSet?.map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <div className="flex-1 flex flex-col">
          <Transcript
            userText={userText}
            setUserText={setUserText}
            onSendMessage={handleSendTextMessage}
            downloadRecording={downloadRecording}
            canSend={
              sessionStatus === "CONNECTED"
            }
          />
          
        {/* Pipeline state and latency, for the travel planning scenarios only. */}
        {isTravelScenario && sessionStatus === "CONNECTED" && sessionId && (
          <div className="mt-2 flex flex-col gap-2 max-h-[45%] overflow-y-auto">
            <ConversationStage sessionId={sessionId} />
            <LatencyPanel sessionId={sessionId} scenario={scenarioKey} />
          </div>
        )}
        </div>
        <aside
          className={`${
            isAvatarVisible
              ? "w-1/2 opacity-100"
              : "w-0 opacity-0"
          } transition-all duration-200 ease-in-out overflow-hidden`}
        >
          {isAvatarVisible && (
            <div className="h-full bg-white rounded-xl p-6 shadow flex flex-col gap-6 overflow-auto">
              <div className="flex flex-col items-center gap-4">
                <RobotAvatar
                  isSpeaking={isAssistantSpeaking}
                  state={avatarState}
                  toggleSpeed={200}
                />
                <div className="bg-slate-900 text-white px-6 py-3 rounded-lg text-center shadow-md">
                  <div className="text-sm text-slate-200">Speaker</div>
                  <div className="mt-1 text-2xl font-semibold tracking-wide">01</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm text-slate-800">
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <span className="text-xl">🔌</span>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Connected</div>
                    <div className="font-semibold">{sessionStatus === "CONNECTED" ? "Yes" : "No"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <span className="text-xl">🎤</span>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Mode</div>
                    <div className="font-semibold">{isPTTActive ? "Push to Talk" : "Voice Detection"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <span className="text-xl">🤖</span>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Avatar State</div>
                    <div className="font-semibold capitalize">{avatarState}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <span className="text-xl">🗣️</span>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Assistant Speaking</div>
                    <div className="font-semibold">{isAssistantSpeaking ? "Yes" : "No"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <span className="text-xl">🎙️</span>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Recording</div>
                    <div className="font-semibold">{isRecording ? "Active" : "Idle"}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <div className="text-base font-semibold text-slate-900 mb-2">Conversation Phase</div>
                <p>
                  Travel planning intent resolution details are shown in the transcript pane. The avatar reflects listening, thinking, and speaking states in real time.
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isAvatarVisible={isAvatarVisible}
        setIsAvatarVisible={setIsAvatarVisible}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;
