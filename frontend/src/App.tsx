import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircle, Mic, Plus, Send, X } from 'lucide-react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

interface Message {
  role: 'user' | 'bot';
  text: string;
  isAudio?: boolean;
}

type LeadStep = 'email' | 'name' | 'chat';

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: {
    resultIndex: number;
    results: ArrayLike<ArrayLike<{ transcript: string }>>;
  }) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;


const resolveApiBaseUrl = (): string => {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  if (typeof window !== 'undefined') {
    return `${window.location.origin}/backend`;
  }


  return 'http://localhost:8000';
};

const API_BASE_URL = resolveApiBaseUrl();
const SESSION_STORAGE_KEY = 'chatbot_session_id';

const ChatBotIcon = ({ className }: { className?: string }) => (
  <img src="/digicoco comapny logo.jpg" alt="DIGICoCo Logo" className={className} />
);

const decodeHeaderValue = (value: string | null): string => {
  if (!value) {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeMarkdownText = (text: string): string => {
  const normalized = (text || '').replace(/\r\n?/g, '\n');
  const fenceCount = (normalized.match(/(^|\n)```/g) || []).length;
  if (fenceCount % 2 === 1) {
    return `${normalized}\n\n\`\`\``;
  }
  return normalized;
};

const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      className="vtl-markdown"
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      }}
    >
      {normalizeMarkdownText(text)}
    </ReactMarkdown>
  );
}

const createSessionId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  }
  return `session_${Date.now()}`;
};

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreamingResponse, setIsStreamingResponse] = useState(false);
  const [isWaitingForFirstToken, setIsWaitingForFirstToken] = useState(false);
  const [isVoiceRequestInFlight, setIsVoiceRequestInFlight] = useState(false);

  const [sessionId, setSessionId] = useState('');
  const [leadStep, setLeadStep] = useState<LeadStep>('chat');
  const [userEmail, setUserEmail] = useState('');
  const [userName, setUserName] = useState('');
  const [sessions, setSessions] = useState<{ id: string; name: string; preview: string; lastSeen: string }[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number>(0);
  const isStoppingRecordingRef = useRef(false);
  const pendingVoiceTurnRef = useRef<{ userIndex: number; botIndex: number } | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const liveVoiceTranscriptRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const loadSessionsFromBackend = async (email: string) => {
    if (!email) return;
    setIsLoadingSessions(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/sessions/list?email=${encodeURIComponent(email)}`);
      if (res.ok) {
        const data = await res.json();
        const fetched = (data.sessions || []).map((s: { session_id: string; name: string; preview: string; last_seen_at: string }) => ({
          id: s.session_id,
          name: s.name || 'Session',
          preview: s.preview || '',
          lastSeen: s.last_seen_at || '',
        }));
        setSessions(fetched);
        // Also persist to localStorage as cache
        localStorage.setItem('chat_history', JSON.stringify(fetched.slice(0, 20)));
      }
    } catch (e) {
      console.error('Failed to load sessions', e);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  const switchToSession = async (sid: string) => {
    if (sid === sessionId) return;
    localStorage.setItem(SESSION_STORAGE_KEY, sid);
    try {
      const [sessionRes, historyRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/session/${encodeURIComponent(sid)}`),
        fetch(`${API_BASE_URL}/api/session/${encodeURIComponent(sid)}/history`),
      ]);
      if (sessionRes.ok) {
        const sData = await sessionRes.json();
        setUserEmail(sData.email || '');
        setUserName(sData.name || '');
        setLeadStep('chat');
        setSessionId(sid);
      }
      if (historyRes.ok) {
        const hData = await historyRes.json();
        setMessages(hData.messages && hData.messages.length > 0
          ? hData.messages
          : [{ role: 'bot', text: 'No messages found for this session.' }]
        );
      }
    } catch (e) {
      console.error('Failed to switch session', e);
    }
  };

  const stopAudio = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      currentAudioRef.current = null;
    }
  };

  useEffect(() => {
    const storedSessions = localStorage.getItem('chat_history');
    if (storedSessions) {
      try {
        setSessions(JSON.parse(storedSessions));
      } catch (e) {
        console.error('Failed to parse history', e);
      }
    }

    const storedSessionId = localStorage.getItem(SESSION_STORAGE_KEY)?.trim();
    if (storedSessionId) {
      (async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/api/session/${encodeURIComponent(storedSessionId)}`);
          if (res.ok) {
            const data = await res.json();
            setSessionId(storedSessionId);
            setUserEmail(data.email || '');
            setUserName(data.name || '');
            setLeadStep('chat');

            // Load full history from Supabase
            try {
              const historyRes = await fetch(`${API_BASE_URL}/api/session/${encodeURIComponent(storedSessionId)}/history`);
              if (historyRes.ok) {
                const historyData = await historyRes.json();
                setMessages(historyData.messages && historyData.messages.length > 0
                  ? historyData.messages
                  : [{ role: 'bot', text: `Welcome back, ${data.name || 'friend'}! How can I help you today?` }]
                );
              } else {
                setMessages([{ role: 'bot', text: `Welcome back, ${data.name || 'friend'}! How can I help you today?` }]);
              }
            } catch {
              setMessages([{ role: 'bot', text: `Welcome back, ${data.name || 'friend'}! How can I help you today?` }]);
            }

            // Load all sessions for this email
            if (data.email) {
              void loadSessionsFromBackend(data.email);
            }
            return;
          }
        } catch (e) {
          // fall back to fresh lead flow
        }
        setSessionId(createSessionId());
        setLeadStep('email');
        setUserEmail('');
        setUserName('');
        setMessages([{ role: 'bot', text: 'Hi! Before we start, what is your email address?' }]);
      })();
      return;
    }

    setSessionId(createSessionId());
    setLeadStep('email');
    setUserEmail('');
    setUserName('');
    setMessages([{ role: 'bot', text: 'Hi! Before we start, what is your email address?' }]);
  }, []);

  const handleNewChat = () => {
    const newSid = createSessionId();
    setSessionId(newSid);
    localStorage.setItem(SESSION_STORAGE_KEY, newSid);
    setMessages([]);

    // If we have a user, just go to chat step with fresh history
    // Otherwise go back to lead flow
    if (userEmail) {
      setLeadStep('chat');
      setMessages([{ role: 'bot', text: `Welcome back, ${userName || 'friend'}! How can I help you today?` }]);
    } else {
      setLeadStep('email');
      setMessages([{ role: 'bot', text: 'Hi! Before we start, what is your email address?' }]);
    }

    // Refresh sessions list
    if (userEmail) {
      void loadSessionsFromBackend(userEmail);
    }
  };


  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  const appendToLatestBotMessage = (chunk: string) => {
    if (!chunk) {
      return;
    }

    setMessages((prev) => {
      const next = [...prev];
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].role === 'bot') {
          next[index] = { ...next[index], text: `${next[index].text}${chunk}` };
          return next;
        }
      }
      return [...next, { role: 'bot', text: chunk }];
    });
  };

  const setLatestBotMessageText = (text: string) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].role === 'bot') {
          next[index] = { ...next[index], text };
          return next;
        }
      }
      return [...next, { role: 'bot', text }];
    });
  };

  const submitUserMessage = async (rawMessage: string) => {
    stopAudio();
    if (!rawMessage.trim()) {
      return;
    }

    if (leadStep !== 'chat') {
      const leadInput = rawMessage.trim();

      if (leadStep === 'email') {
        if (!isValidEmail(leadInput)) {
          setMessages((prev) => [...prev, { role: 'bot', text: 'Please enter a valid email address.' }]);
          return;
        }

        setUserEmail(leadInput);
        setMessages((prev) => [
          ...prev,
          { role: 'user', text: leadInput },
          { role: 'bot', text: 'Thanks! Now please share your name.' },
        ]);
        setLeadStep('name');
        return;
      }

      if (leadStep === 'name') {
        setUserName(leadInput);
        // register session on backend (creates session row and user)
        try {
          const res = await fetch(`${API_BASE_URL}/api/session/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: userEmail, name: leadInput, session_id: sessionId || undefined }),
          });
          if (res.ok) {
            const data = await res.json();
            const sid = data.session_id || sessionId || `s_${crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
            localStorage.setItem(SESSION_STORAGE_KEY, sid);
            setSessionId(sid);

            // Reload sessions from backend with full list
            void loadSessionsFromBackend(userEmail);
          }
        } catch (e) {
          // ignore — session may still work in-memory
          console.error('Session register failed', e);
        }

        setMessages((prev) => [
          ...prev,
          { role: 'user', text: leadInput },
          { role: 'bot', text: `Nice to meet you, ${leadInput}. How can I help you today?` },
        ]);
        setLeadStep('chat');
        return;
      }
    }

    const userMsg = rawMessage.trim();
    setMessages((prev) => [...prev, { role: 'user', text: userMsg }]);


    setIsLoading(true);
    setIsStreamingResponse(true);
    setIsWaitingForFirstToken(true);
    setMessages((prev) => [...prev, { role: 'bot', text: '' }]);

    try {
      const formData = new FormData();
      formData.append('query', userMsg);
      formData.append('session_id', sessionId);

      const headers: Record<string, string> = {};
      if (userEmail) headers['X-User-Email'] = userEmail;
      if (userName) headers['X-User-Name'] = userName;

      const response = await fetch(`${API_BASE_URL}/api/chat/text/stream`, {
        method: 'POST',
        body: formData,
        headers,
      });

      if (!response.ok || !response.body) {
        throw new Error('Streaming API failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedText = '';
      let resolvedSessionId = sessionId;

      const processEvent = (eventType: string, payload: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== 'object') {
          return;
        }

        const data = parsed as {
          token?: unknown;
          reply?: unknown;
          session_id?: unknown;
          message?: unknown;
        };

        if (eventType === 'token') {
          const token = typeof data.token === 'string' ? data.token : '';
          if (token) {
            setIsWaitingForFirstToken(false);
            streamedText += token;
            appendToLatestBotMessage(token);
          }
          return;
        }

        if (eventType === 'done') {
          setIsWaitingForFirstToken(false);
          const doneReply = typeof data.reply === 'string' ? data.reply : '';
          if (!streamedText.trim() && doneReply) {
            streamedText = doneReply;
            setLatestBotMessageText(doneReply);
          }

          if (typeof data.session_id === 'string' && data.session_id.trim()) {
            resolvedSessionId = data.session_id.trim();
          }
          return;
        }

        if (eventType === 'error') {
          const errorMessage = typeof data.message === 'string'
            ? data.message
            : 'Sorry, an error occurred while streaming the response.';
          throw new Error(errorMessage);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let splitIndex = buffer.indexOf('\n\n');
        while (splitIndex !== -1) {
          const rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);

          const lines = rawEvent.replace(/\r/g, '').split('\n');
          let eventType = 'message';
          const dataLines: string[] = [];

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
              continue;
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (dataLines.length > 0) {
            processEvent(eventType, dataLines.join('\n'));
          }

          splitIndex = buffer.indexOf('\n\n');
        }
      }

      // Handle a final event block if stream closes without trailing delimiter.
      const trailingEvent = buffer.trim();
      if (trailingEvent) {
        const lines = trailingEvent.replace(/\r/g, '').split('\n');
        let eventType = 'message';
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length > 0) {
          processEvent(eventType, dataLines.join('\n'));
        }
      }

      if (!streamedText.trim()) {
        throw new Error('Empty streamed response');
      }
    } catch {
      setLatestBotMessageText('Sorry, an error occurred while streaming the response.');
    } finally {
      setIsWaitingForFirstToken(false);
      setIsStreamingResponse(false);
      setIsLoading(false);
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) {
      return;
    }

    const messageToSend = inputText;
    setInputText('');
    await submitUserMessage(messageToSend);
  };

  const startRecording = async () => {
    stopAudio();
    if (isLoading || isRecording || leadStep !== 'chat') {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      isStoppingRecordingRef.current = false;

      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = handleAudioStop;
      mediaRecorder.start();

      const speechCtor = (
        window as Window & {
          SpeechRecognition?: BrowserSpeechRecognitionCtor;
          webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
        }
      ).SpeechRecognition || (
        window as Window & {
          SpeechRecognition?: BrowserSpeechRecognitionCtor;
          webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
        }
      ).webkitSpeechRecognition;

      if (speechCtor) {
        const recognizer = new speechCtor();
        recognizer.continuous = true;
        recognizer.interimResults = true;
        recognizer.lang = 'en-US';
        recognizer.onresult = (event) => {
          let transcript = '';
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            transcript += event.results[i][0]?.transcript || '';
          }
          liveVoiceTranscriptRef.current = transcript.trim() || liveVoiceTranscriptRef.current;
        };
        recognizer.onerror = () => {
          speechRecognitionRef.current = null;
        };

        try {
          recognizer.start();
          speechRecognitionRef.current = recognizer;
        } catch {
          speechRecognitionRef.current = null;
        }
      }

      setIsRecording(true);
    } catch (error) {
      console.error('Microphone access error:', error);
      setMessages((prev) => [
        ...prev,
        {
          role: 'bot',
          text: 'Microphone access is blocked. If you are viewing this on a website, the website needs to allow microphone permissions in its iframe settings.'
        }
      ]);
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current || !isRecording || isStoppingRecordingRef.current) {
      return;
    }

    if (mediaRecorderRef.current.state !== 'inactive') {
      isStoppingRecordingRef.current = true;
      mediaRecorderRef.current.stop();
      speechRecognitionRef.current?.stop();
      speechRecognitionRef.current = null;
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
    }
  };

  const updatePendingVoiceTurn = (userText: string, botText: string) => {
    setMessages((prev) => {
      const turn = pendingVoiceTurnRef.current;
      if (!turn) {
        return [...prev, { role: 'user', text: userText, isAudio: true }, { role: 'bot', text: botText, isAudio: true }];
      }

      if (
        turn.userIndex >= 0 &&
        turn.botIndex >= 0 &&
        prev[turn.userIndex]?.role === 'user' &&
        prev[turn.userIndex]?.isAudio &&
        prev[turn.botIndex]?.role === 'bot' &&
        prev[turn.botIndex]?.isAudio
      ) {
        const next = [...prev];
        next[turn.userIndex] = { ...next[turn.userIndex], text: userText };
        next[turn.botIndex] = { ...next[turn.botIndex], text: botText };
        return next;
      }

      return [...prev, { role: 'user', text: userText, isAudio: true }, { role: 'bot', text: botText, isAudio: true }];
    });
  };

  const handleAudioStop = async () => {
    const recordingDurationMs = Date.now() - recordingStartedAtRef.current;
    const chunkType = audioChunksRef.current[0]?.type || 'audio/webm';
    const audioBlob = new Blob(audioChunksRef.current, { type: chunkType });
    if (audioBlob.size === 0 || recordingDurationMs < 300) {
      isStoppingRecordingRef.current = false;
      setMessages((prev) => [...prev, { role: 'bot', text: 'Recording is too short. Please hold the mic and try again.' }]);
      return;
    }

    setIsLoading(true);
    setIsVoiceRequestInFlight(true);

    const audioFile = new File([audioBlob], 'recording.webm', { type: chunkType });
    const formData = new FormData();
    formData.append('audio', audioFile);

    let finalUserText = liveVoiceTranscriptRef.current.trim();

    if (!finalUserText) {
      try {
        const transcribeRes = await fetch(`${API_BASE_URL}/api/chat/transcribe`, {
          method: 'POST',
          body: formData,
        });
        if (transcribeRes.ok) {
          const transcribeData = await transcribeRes.json();
          finalUserText = transcribeData.text;
        }
      } catch (e) {
        console.error("Transcription failed", e);
      }
    }

    finalUserText = finalUserText || "Voice Message";

    setMessages((prev) => {
      const userIndex = prev.length;
      const botIndex = prev.length + 1;
      pendingVoiceTurnRef.current = { userIndex, botIndex };
      return [
        ...prev,
        { role: 'user', text: finalUserText, isAudio: true },
        { role: 'bot', text: '', isAudio: true },
      ];
    });

    try {
      const voiceFormData = new FormData();
      if (finalUserText && finalUserText !== "Voice Message") {
        voiceFormData.append('query', finalUserText);
      } else {
        voiceFormData.append('audio', audioFile);
      }

      const response = await fetch(`${API_BASE_URL}/api/chat/voice`, {
        method: 'POST',
        headers: {
          'X-Session-Id': sessionId,
          ...(userEmail ? { 'X-User-Email': userEmail } : {}),
          ...(userName ? { 'X-User-Name': userName } : {}),
        },
        body: voiceFormData,
      });

      if (!response.ok) {
        throw new Error('Voice API failed');
      }

      let userQuery = decodeHeaderValue(response.headers.get('X-User-Query-Encoded'))
        || response.headers.get('X-User-Query')
        || 'Voice Message';
      let botReply = decodeHeaderValue(response.headers.get('X-Bot-Reply-Encoded'))
        || response.headers.get('X-Bot-Reply')
        || 'Audio Reply';

      if (!pendingVoiceTurnRef.current) {
        setMessages((prev) => {
          const userIndex = prev.length;
          const botIndex = prev.length + 1;
          pendingVoiceTurnRef.current = { userIndex, botIndex };
          return [
            ...prev,
            { role: 'user', text: userQuery, isAudio: true },
            { role: 'bot', text: '', isAudio: true },
          ];
        });
      }

      try {
        const lastTurnResponse = await axios.get(`${API_BASE_URL}/api/chat/last`, {
          params: { session_id: sessionId },
        });
        userQuery = lastTurnResponse.data.user_query || userQuery;
        botReply = lastTurnResponse.data.reply || botReply;
      } catch {
        // Keep header-based fallbacks when last-turn lookup is unavailable.
      }

      updatePendingVoiceTurn(userQuery || 'Voice Message', botReply || 'Audio Reply');

      const audioResponseBlob = await response.blob();
      if (audioResponseBlob.size > 0) {
        const audioUrl = URL.createObjectURL(audioResponseBlob);
        const audio = new Audio(audioUrl);
        currentAudioRef.current = audio;
        try {
          await audio.play();
        } catch {
          // Keep text response visible even when autoplay is blocked.
        }
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          if (currentAudioRef.current === audio) {
            currentAudioRef.current = null;
          }
        };
      }
    } catch {
      updatePendingVoiceTurn('Voice Message', 'Sorry, failed to process audio.');
    } finally {
      audioChunksRef.current = [];
      isStoppingRecordingRef.current = false;
      pendingVoiceTurnRef.current = null;
      liveVoiceTranscriptRef.current = '';
      setIsVoiceRequestInFlight(false);
      setIsLoading(false);
    }
  };

  const voiceHintText = isRecording
    ? '🔴 Recording... tap again to send'
    : 'Tap mic to record • Tap again to send';

  const handleVoiceButtonClick = () => {
    if (isRecording) {
      stopRecording();
      return;
    }
    void startRecording();
  };

  return (
    <div className="h-screen w-full bg-slate-200/50 flex items-center justify-end overflow-hidden">
      <div className="flex h-screen lg:h-[95vh] w-full lg:w-[70%] overflow-hidden bg-white shadow-2xl lg:rounded-3xl border border-slate-200/60">
        {/* Sidebar - Desktop */}
        <aside className="hidden lg:flex flex-col w-72 bg-white border-r border-slate-200 shadow-sm z-20">
          <div className="p-3 border-b border-slate-100 flex justify-center">
            <img src="/digicoco.png" alt="DIGICoCo Logo" className="w-20 h-auto object-contain" />
          </div>

          <nav className="flex-1 p-4 space-y-4 overflow-y-auto">
            <button
              onClick={handleNewChat}
              style={{ backgroundColor: '#167EB7' }}
              className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-white shadow-lg hover:opacity-90 transition-all active:scale-95"
            >
              <Plus className="w-5 h-5" />
              <span className="text-sm font-bold uppercase tracking-wider">New Chat</span>
            </button>

            <div className="space-y-2 pt-2">
              <div className="px-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center justify-between">
                <span>History</span>
                {isLoadingSessions && <div className="w-3 h-3 border border-slate-300 border-t-slate-500 rounded-full animate-spin" />}
              </div>
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => void switchToSession(s.id)}
                    className={`px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${s.id === sessionId
                      ? 'bg-blue-50 border-blue-200'
                      : 'border-transparent hover:bg-slate-50'
                      }`}
                  >
                    <p className="text-xs font-semibold text-slate-700 truncate">{s.name}</p>
                    {s.preview && <p className="text-[10px] text-slate-400 truncate mt-0.5">{s.preview}</p>}
                  </div>
                ))}
                {sessions.length === 0 && !isLoadingSessions && (
                  <p className="px-3 text-[10px] text-slate-300 italic">No recent sessions</p>
                )}
              </div>
            </div>
          </nav>

          {userName && (
            <div className="p-4 border-t border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-3">
                <div
                  style={{ backgroundColor: '#167EB7' }}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shadow-sm"
                >
                  {userName.charAt(0).toUpperCase()}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-bold text-slate-800 truncate">{userName}</span>
                  <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Member</span>
                </div>
              </div>
            </div>
          )}
        </aside>


        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col min-w-0 relative h-full">
          {/* Header - Mobile & Desktop */}
          {/* <header 
          className="h-14 lg:h-16 bg-white/80 backdrop-blur-md border-b border-slate-200/60 flex items-center justify-between px-4 lg:px-8 z-10"
        >
          <div className="flex items-center gap-3 lg:hidden">
            <img src="/digicoco.png" alt="DIGICoCo Logo" className="h-4 w-auto" />
          </div>

          <div className="hidden lg:flex items-center gap-3">
          </div>

          <div className="flex items-center gap-4">
          </div>
        </header> */}

          {/* Chat Messages */}
          <section className="flex-1 overflow-y-auto px-4 py-6 lg:px-24 lg:py-10 space-y-8 scroll-smooth">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto animate-fade-in">
                <div className="w-12 h-12 flex items-center justify-center mb-6">
                  <img src="/digicoco.png" alt="DIGICoCo Logo" className="w-full h-auto object-contain" />
                </div>
                <h3 className="text-2xl font-bold font-outfit text-slate-800 mb-2">How can I help you today?</h3>
                <p className="text-slate-500 text-sm leading-relaxed">
                  I'm your DIGIC Assistant, here to provide information and support. Type a message to get started.
                </p>
              </div>
            )}

            {messages.map((msg, idx) => (
              <div
                key={`${msg.role}-${idx}`}
                className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
                style={{ animationDelay: `${Math.min(idx * 0.05, 0.5)}s` }}
              >
                <div className={`flex flex-col max-w-[85%] lg:max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`relative p-3 lg:p-4 shadow-sm transition-all duration-200 text-sm ${msg.role === 'user'
                      ? 'text-slate-800 rounded-2xl rounded-tr-none'
                      : 'bg-white border border-slate-200/80 text-slate-800 rounded-2xl rounded-tl-none'
                      }`}
                    style={msg.role === 'user' ? { backgroundColor: '#ffffff', border: '1px solid #e2e8f0' } : {}}
                  >
                    {msg.role === 'bot' && msg.text.trim().length === 0 && isLoading && idx === messages.length - 1 ? (
                      <div className="flex items-center gap-3 text-slate-400">
                        <div className="flex gap-1">
                          <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: '0s' }}></div>
                          <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                          <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                        <span className="text-xs font-medium">Thinking...</span>
                      </div>
                    ) : msg.role === 'bot' ? (
                      <MarkdownMessage text={msg.text} />
                    ) : (
                      <span className="whitespace-pre-wrap break-words leading-relaxed">{msg.text}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {isLoading && !isStreamingResponse && !isVoiceRequestInFlight && !(messages.length > 0 && messages[messages.length - 1]?.role === 'bot' && messages[messages.length - 1]?.text.trim().length === 0) && (
              <div className="flex justify-start animate-fade-in">
                <div className="bg-white border border-slate-200/80 p-4 rounded-2xl rounded-tl-none flex items-center gap-3 text-slate-400 shadow-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  <span className="text-xs font-medium">Processing...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </section>

          {/* Input Area */}
          <footer className="p-3 lg:p-4 border-t border-slate-100 bg-white">
            <div className="max-w-4xl mx-auto">
              <form
                onSubmit={handleTextSubmit}
                className="relative flex items-center gap-2 p-1 rounded-2xl bg-slate-50 border border-slate-200 focus-within:border-primary/50 transition-all shadow-sm"
              >
                <div className="flex-1 relative pl-2">
                  <textarea
                    rows={1}
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleTextSubmit(e);
                      }
                    }}
                    placeholder={leadStep === 'email' ? 'Write a message...' : leadStep === 'name' ? 'Name...' : 'Write a message...'}
                    className="w-full px-2 py-2 bg-transparent text-sm text-slate-800 placeholder-slate-400 focus:outline-none resize-none max-h-24 min-h-[36px]"
                    disabled={isLoading}
                  />
                </div>

                <button
                  type="submit"
                  disabled={!inputText.trim() || isLoading}
                  style={{ backgroundColor: '#167EB7' }}
                  className="p-2.5 text-white rounded-xl hover:opacity-90 transition-all active:scale-95 disabled:opacity-50 disabled:scale-100 flex items-center justify-center"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );


}

export default App;
