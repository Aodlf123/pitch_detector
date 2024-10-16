import React, { useState, useEffect, useRef } from 'react';  // React와 필요한 훅들을 임포트합니다.
import { PitchDetector } from 'pitchy';  // pitchy 라이브러리에서 PitchDetector를 임포트합니다.

function App() {
  // 상태 변수들을 선언합니다.
  const [pitch, setPitch] = useState(0);  // 현재 감지된 음의 피치(Hz)
  const [clarity, setClarity] = useState(0);  // 피치 감지의 명확도 (0-1)
  const [decibel, setDecibel] = useState(-Infinity);  // 현재 음량 (dB)
  const [graphData, setGraphData] = useState([]);  // 그래프를 그리기 위한 데이터
  const [startTime, setStartTime] = useState(Date.now());  // 녹음 시작 시간
  const [dimensions, setDimensions] = useState({ width: 0, height: 600 });  // 그래프의 크기
  
  // useRef를 사용하여 컴포넌트 생명주기 동안 유지되어야 하는 값들을 저장합니다.
  const audioContextRef = useRef(null);  // Web Audio API의 AudioContext
  const analyserRef = useRef(null);  // 오디오 분석을 위한 AnalyserNode
  const sourceRef = useRef(null);  // 오디오 입력 소스
  const detectorRef = useRef(null);  // 피치 감지기
  const containerRef = useRef(null);  // 컨테이너 DOM 요소에 대한 참조

  const graphMaxDatapoint = 100;  // 그래프에 표시될 최대 데이터 포인트 수
  const marginTop = 20;  // 그래프 상단 여백
  const marginBottom = 20;  // 그래프 하단 여백

  // 주파수를 음계로 변환하는 함수
  function getNote(frequency) {
    const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const c0 = 16.35;  // C0의 주파수
    const halfStepsBelowMiddleC = Math.round(12 * Math.log2(frequency / c0));
    const octave = Math.floor(halfStepsBelowMiddleC / 12);
    const noteIndex = halfStepsBelowMiddleC % 12;
    return notes[noteIndex] + octave;
  }

  // C1부터 C8까지의 주파수를 계산합니다.

  //  1부터 8 까지 포함하는 배열 만들고
  const octaves = Array.from({length: 8}, (_, i) => i + 1);
  //  c0 에 2 ** n 곱해서 각 옥타브의 C 의 주파수 값 구함
  const cFrequencies = octaves.map(octave => 16.35 * Math.pow(2, octave));

  // 로그 스케일로 Y축 값을 변환하는 함수
  function logScale(value) {
    const minValue = cFrequencies[0];  // C1의 주파수
    const maxValue = cFrequencies[7];  // C8의 주파수
    const minPixel = dimensions.height - marginBottom;
    const maxPixel = marginTop;
    
    const logMin = Math.log(minValue);
    const logMax = Math.log(maxValue);

    //  로그 값 변화를 픽셀 값에 매핑해줘야 함. 그래서 일단 어떤 비율로 변환할 지 계산하고
    //  (픽셀의 가능 바운더리 / 로그의 가능 바운더리)
    const scale = (maxPixel - minPixel) / (logMax - logMin);
    
    //  최소 픽셀 위치에 이번 주파수의 로그 값을 픽셀 스케일로 변환한 만큼 더해줌
    return minPixel + scale * (Math.log(Math.max(value, minValue)) - logMin);
  }

  // 오디오 버퍼의 RMS(Root Mean Square) 값을 계산하는 함수
  //  버퍼의 windowsize 만큼 잘려서 담긴 파동의 magnitute 값의 제곱의 평균을 구하고,
  //  그 제곱근을 구함 즉, 해당 window 의 데시벨 (수식에 넣어서 진짜 데시벨 수치로 바꿔야 하긴 하지만)
  //  제곱했다가 제곱근 구하는 이유는, 음성 파동은 양수값 음수값을 왔다갔다 하기 때문.
  function calculateRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  // 컨테이너 크기 변경을 감지하고 그래프 크기를 조정하는 useEffect
  //  이거 쓸 데 없음. 나중에도 쓸일 없으면 지우는 게 나을듯.
  useEffect(() => {
    function handleResize() {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: 500  // 그래프의 높이를 500px로 고정
        });
      }
    }

    handleResize();  // 초기 크기 설정
    window.addEventListener('resize', handleResize);  // 리사이즈 이벤트 리스너 추가

    // 컴포넌트 언마운트 시 이벤트 리스너 제거
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 오디오 설정 및 피치 감지를 수행하는 주요 useEffect
  useEffect(() => {
    async function setupAudio() {
      try {
        // 사용자의 마이크에 접근합니다.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // AudioContext와 AnalyserNode를 생성합니다.
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        analyserRef.current = audioContextRef.current.createAnalyser();
        //  stream 형태의 audio source 를 오디오 컨텍스트로부터 추출함
        sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
        //  그리고 그 스트림 데이터를 위에서 만든 analyser 에 연결.
        sourceRef.current.connect(analyserRef.current);

        // 피치 감지기를 설정합니다.

        //  고속 푸리에 변환에 몇 개의 샘플을 사용할 지, 즉, windowsize 를 결정
        const bufferLength = analyserRef.current.fftSize; 
        detectorRef.current = PitchDetector.forFloat32Array(bufferLength);
        const input = new Float32Array(bufferLength);

        setStartTime(Date.now());  // 녹음 시작 시간 설정

        // 주기적으로 피치를 업데이트하는 함수
        function updatePitch() {
          analyserRef.current.getFloatTimeDomainData(input);

          // 음량(RMS)을 계산하고 데시벨로 변환합니다.
          const rms = calculateRMS(input);
          const newDecibel = 20 * Math.log10(rms);
          setDecibel(newDecibel);

          const currentTime = (Date.now() - startTime) / 1000;

          // 음량이 충분히 큰 경우에만 피치를 감지합니다.
          if (newDecibel > -40) {
            const [pitchResult, clarityResult] = detectorRef.current.findPitch(input, audioContextRef.current.sampleRate);

            // 명확도가 충분히 높은 경우에만 피치를 업데이트합니다.
            if (clarityResult > 0.9) {
              const correctedPitch = pitchResult;
              setPitch(correctedPitch);
              setClarity(clarityResult);
              setGraphData(prevData => [...prevData, { time: currentTime, pitch: correctedPitch }].slice(-200));
            } else {
              setPitch(0);
              setClarity(0);
              setGraphData(prevData => [...prevData, { time: currentTime, pitch: null }].slice(-200));
            }
          } else {
            setPitch(0);
            setClarity(0);
            setGraphData(prevData => [...prevData, { time: currentTime, pitch: null }].slice(-200));
          }
        }

        // 50ms마다 updatePitch 함수를 호출합니다.
        // 즉, 50ms 마다 음성 입력을 받고, 그래프에 데이터를 추가
        const intervalId = setInterval(updatePitch, 50);

        // 컴포넌트가 언마운트되면 정리 작업을 수행합니다.
        return () => {
          clearInterval(intervalId);
          if (sourceRef.current) {
            sourceRef.current.disconnect();
          }
          if (audioContextRef.current) {
            audioContextRef.current.close();
          }
        };
      } catch (error) {
        console.error('Error accessing the microphone', error);
      }
    }

    setupAudio();
  }, []);

  const graphWidth = dimensions.width / 3;  // 그래프의 너비를 전체 너비의 1/3로 설정

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100 p-4">
      <div className="w-full max-w-7xl mx-auto bg-white rounded-lg shadow-lg overflow-hidden" ref={containerRef}>
        <h1 className="text-2xl font-bold mb-4 text-center p-4">Pitch Detector</h1>
        <div className="flex flex-col">
          <div className="p-4 bg-gray-50 flex justify-around">
            <p className="text-lg"><span className="font-semibold">Pitch:</span> {pitch.toFixed(2)} Hz ({getNote(pitch)})</p>
            <p className="text-lg"><span className="font-semibold">Clarity:</span> {(clarity * 100).toFixed(2)}%</p>
            <p className="text-lg"><span className="font-semibold">Decibel:</span> {decibel.toFixed(2)} dB</p>
          </div>
          <div className="p-4">
            <div className="border border-gray-300 rounded-lg overflow-hidden">
              <svg
                width={dimensions.width}
                height={dimensions.height}
                viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
                preserveAspectRatio="none"
                className="overflow-visible"
              >
                <defs>
                  <clipPath id="graph-area">
                    <rect x="0" y={marginTop} width={dimensions.width} height={dimensions.height - marginTop - marginBottom} />
                  </clipPath>
                </defs>
                <rect x="0" y="0" width={dimensions.width} height={dimensions.height} fill="black" />
                <g>
                  {/* 파란색 세로선 (그래프의 1/3 지점) */}
                  <line x1={graphWidth} y1={marginTop} x2={graphWidth} y2={dimensions.height - marginBottom} stroke="#0000FF" strokeWidth="2" />

                  {/* C1부터 C8까지의 가로선과 라벨 */}
                  {cFrequencies.map((freq, index) => (
                    <g key={freq}>
                      <line
                        x1="0"
                        y1={logScale(freq)}
                        x2={dimensions.width}
                        y2={logScale(freq)}
                        stroke="white"
                        strokeOpacity="0.2"
                      />
                      <text x="15" y={logScale(freq)} dominantBaseline="middle" textAnchor="start" fontSize="10" fill="white">
                        C{index + 1}
                      </text>
                    </g>
                  ))}
                  
                  {/* X축 (주석 처리됨)
                  <line x1="0" y1={dimensions.height - marginBottom} x2={graphWidth} y2={dimensions.height - marginBottom} stroke="white" />
                  {[0, 5, 10, 15, 20].map((tick) => (
                    <g key={tick} transform={`translate(${(tick / 20) * graphWidth}, ${dimensions.height - marginBottom})`}>
                      <line x1="0" y1="0" x2="0" y2="5" stroke="white" />
                      <text x="0" y="20" textAnchor="middle" fontSize="10" fill="white">
                        {tick}s
                      </text>
                    </g>
                  ))} */}
                </g>
                
                {/* 피치 데이터를 그래프로 그립니다 */}
                <g clipPath="url(#graph-area)">
                  <path
                    d={graphData.reduce((path, point, index) => {
                      if (index === 0 || point.pitch === null) return path;
                      const prevPoint = graphData[index - 1];
                      if (prevPoint.pitch === null) return path;

                      const x1 = graphWidth - (graphData.length - index + 1) * (graphWidth / graphMaxDatapoint);
                      const x2 = graphWidth - (graphData.length - index) * (graphWidth / graphMaxDatapoint);
                      const y1 = logScale(prevPoint.pitch);
                      const y2 = logScale(point.pitch);

                      return `${path} M${x1},${y1} L${x2},${y2}`;
                    }, '')}
                    stroke="#FFA500"
                    strokeWidth="2"
                    fill="none"
                  />
                </g>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;