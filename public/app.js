const startButton = document.querySelector("#start-call");
const endButton = document.querySelector("#end-call");
const checkButton = document.querySelector("#run-check");
const testVoiceButton = document.querySelector("#test-voice");
const statusEl = document.querySelector("#call-status");
const micStatusEl = document.querySelector("#mic-status");
const speakerStatusEl = document.querySelector("#speaker-status");
const logEl = document.querySelector("#event-log");
const catalogEl = document.querySelector("#catalog");
const remoteAudio = document.querySelector("#remote-audio");

let peerConnection = null;
let localStream = null;
let dataChannel = null;
let audioContext = null;
let analyser = null;
let micAnimationFrame = null;
let toolCallInFlight = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function setMicStatus(message) {
  micStatusEl.textContent = message;
}

function setSpeakerStatus(message) {
  speakerStatusEl.textContent = message;
}

function logEvent(type, message) {
  if (logEl.querySelector(".muted")) {
    logEl.innerHTML = "";
  }

  const entry = document.createElement("p");
  entry.className = "event";
  entry.innerHTML = `<span class="type">${type}</span>${message}`;
  logEl.prepend(entry);
}

function summarizePayload(payload) {
  if (payload.type === "response.done") {
    const status = payload.response?.status || "unknown";
    const statusDetails =
      payload.response?.status_details?.error?.message ||
      payload.response?.status_details?.reason ||
      "No extra details.";
    return `Response finished with status: ${status}. ${statusDetails}`;
  }

  if (payload.type === "response.created") {
    return `Response created with id ${payload.response?.id || "unknown"}.`;
  }

  if (payload.type === "session.created" || payload.type === "session.updated") {
    return JSON.stringify(
      {
        model: payload.session?.model,
        voice: payload.session?.audio?.output?.voice,
        turnDetection: payload.session?.audio?.input?.turn_detection?.type || null
      },
      null,
      0
    );
  }

  if (payload.type === "error") {
    return payload.error?.message || JSON.stringify(payload);
  }

  return null;
}

async function executeTool(functionName, args) {
  const url =
    functionName === "lookup_plant_care"
      ? `/api/tools/plant-care?plant_name=${encodeURIComponent(args.plant_name || "")}`
      : `/api/tools/home-depot?address=${encodeURIComponent(args.address || "")}`;

  const response = await fetch(url);
  return response.json();
}

async function maybeHandleToolCalls(payload) {
  if (!payload.response?.output || toolCallInFlight) {
    return;
  }

  const toolCalls = payload.response.output.filter((item) => item.type === "function_call");
  if (!toolCalls.length || !dataChannel || dataChannel.readyState !== "open") {
    return;
  }

  toolCallInFlight = true;

  try {
    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.arguments || "{}");
      const toolResult = await executeTool(toolCall.name, args);

      dataChannel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: JSON.stringify(toolResult)
          }
        })
      );
    }

    dataChannel.send(
      JSON.stringify({
        type: "response.create"
      })
    );
  } catch (error) {
    logEvent("error", `Tool call failed: ${error.message}`);
  } finally {
    toolCallInFlight = false;
  }
}

function renderCatalog(plants) {
  catalogEl.innerHTML = plants
    .map(
      (plant) => `
        <article class="plant-card">
          <h3>${plant.name}</h3>
          <p>${plant.pitch}</p>
          <div class="tag-row">
            <span class="tag">$${plant.price}</span>
            <span class="tag">${plant.light}</span>
            <span class="tag">${plant.petSafe ? "Pet safe" : "Not pet safe"}</span>
          </div>
        </article>
      `
    )
    .join("");
}

async function loadCatalog() {
  const response = await fetch("/api/catalog");
  const data = await response.json();
  renderCatalog(data.plants);
}

function cleanUpCall() {
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  if (peerConnection) {
    peerConnection.getSenders().forEach((sender) => sender.track?.stop());
    peerConnection.close();
    peerConnection = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (micAnimationFrame) {
    cancelAnimationFrame(micAnimationFrame);
    micAnimationFrame = null;
  }

  analyser = null;

  remoteAudio.srcObject = null;
  startButton.disabled = false;
  endButton.disabled = true;
  checkButton.disabled = false;
  testVoiceButton.disabled = true;
  setStatus("Idle and ready");
  setMicStatus("Waiting to start");
  setSpeakerStatus("Not tested yet");
}

async function runConnectionCheck() {
  checkButton.disabled = true;
  logEvent("check", "Testing whether your API key can create a realtime session.");

  try {
    const response = await fetch("/api/diagnostics/realtime");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)
      );
    }

    logEvent("check", "Realtime connection check passed. Your API key can create sessions.");
  } catch (error) {
    logEvent("error", `Connection check failed: ${error.message}`);
  } finally {
    checkButton.disabled = false;
  }
}

async function startCall() {
  startButton.disabled = true;
  checkButton.disabled = true;
  setStatus("Requesting microphone access...");
  logEvent("client", "Preparing browser audio and creating a realtime session.");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setMicStatus("Mic permission granted");

    peerConnection = new RTCPeerConnection();
    remoteAudio.autoplay = true;
    remoteAudio.volume = 1;

    remoteAudio.onplay = () => {
      setSpeakerStatus("Remote audio is playing");
      logEvent("audio", "Remote audio playback started.");
    };

    remoteAudio.onpause = () => {
      setSpeakerStatus("Remote audio paused");
    };

    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      setStatus("Fern is connected");
      logEvent("audio", "Remote audio stream connected.");
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      logEvent("webrtc", `Connection state changed to <strong>${state}</strong>.`);

      if (state === "failed" || state === "disconnected" || state === "closed") {
        cleanUpCall();
      }
    };

    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    startMicMonitor(localStream);

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", () => {
      logEvent("channel", "Realtime event channel open.");
      testVoiceButton.disabled = false;
      dataChannel.send(
        JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions:
              "Briefly greet the customer as Fern, say you are an AI plant concierge, and ask one short question about their space."
          }
        })
      );
    });
    dataChannel.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "response.done") {
        maybeHandleToolCalls(payload).catch((error) => {
          logEvent("error", `Tool handling failed: ${error.message}`);
        });
      }

      const text =
        summarizePayload(payload) ||
        payload.transcript ||
        (payload.type === "input_audio_buffer.speech_started" ? "Fern detected that you started speaking." : null) ||
        (payload.type === "input_audio_buffer.speech_stopped" ? "Fern detected that you stopped speaking." : null) ||
        (payload.type === "output_audio_buffer.started" ? "Fern started sending audio back." : null) ||
        (payload.type === "output_audio_buffer.stopped" ? "Fern finished sending audio." : null) ||
        payload.item?.content?.[0]?.transcript ||
        "Event received.";

      logEvent(payload.type, text);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const response = await fetch("/api/realtime/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp"
      },
      body: offer.sdp
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(responseText || "Failed to create realtime call.");
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: responseText
    });

    setStatus("Connected. Start speaking.");
    endButton.disabled = false;
    logEvent("client", "Realtime session established. You can start talking now.");
  } catch (error) {
    console.error(error);
    logEvent("error", error.message);
    cleanUpCall();
  }
}

function startMicMonitor(stream) {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);

  const update = () => {
    if (!analyser) {
      return;
    }

    analyser.getByteTimeDomainData(data);
    let sum = 0;

    for (const value of data) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }

    const rms = Math.sqrt(sum / data.length);

    if (rms > 0.06) {
      setMicStatus("Hearing your voice");
    } else if (rms > 0.02) {
      setMicStatus("Hearing room sound");
    } else {
      setMicStatus("Mic is on, waiting for speech");
    }

    micAnimationFrame = requestAnimationFrame(update);
  };

  update();
}

function testFernVoice() {
  if (!dataChannel || dataChannel.readyState !== "open") {
    logEvent("error", "Voice test is unavailable because the realtime channel is not open.");
    return;
  }

  logEvent("client", "Requesting a speaker test from Fern.");
  setSpeakerStatus("Waiting for Fern audio");
  dataChannel.send(
    JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions:
          "Say exactly: Hello, this is Fern, your AI plant concierge. If you can hear me, your speaker test worked."
      }
    })
  );
}

startButton.addEventListener("click", startCall);
endButton.addEventListener("click", cleanUpCall);
checkButton.addEventListener("click", runConnectionCheck);
testVoiceButton.addEventListener("click", testFernVoice);

loadCatalog().catch((error) => {
  console.error(error);
  logEvent("error", "Failed to load plant catalog.");
});
