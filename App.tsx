import React, { useState, useEffect, useRef } from 'react';
import WaterEffectCanvas from './components/WaterEffectCanvas';

const App: React.FC = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const getCameraStream = async () => {
            try {
                const mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'user' },
                    audio: false,
                });
                setStream(mediaStream);
            } catch (err) {
                console.error("Error accessing camera:", err);
                setError("Could not access the camera. Please grant permission and refresh the page.");
            }
        };

        getCameraStream();

        return () => {
            // Check if stream is not null before trying to access its methods
            if (stream) {
              stream.getTracks().forEach(track => track.stop());
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (stream && videoRef.current) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    const handleVideoMetadata = () => {
        if (videoRef.current) {
            setVideoDimensions({
                width: videoRef.current.videoWidth,
                height: videoRef.current.videoHeight,
            });
        }
    };

    return (
        <main className="relative h-screen w-screen overflow-hidden bg-black text-white">
            {error && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black bg-opacity-75">
                    <div className="text-center p-8 bg-gray-800 rounded-lg shadow-lg max-w-sm">
                        <h2 className="text-2xl font-bold mb-4 text-red-400">Camera Error</h2>
                        <p>{error}</p>
                    </div>
                </div>
            )}
            {!stream && !error && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black bg-opacity-50">
                    <div className="flex items-center space-x-3">
                        <svg className="animate-spin h-8 w-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <p className="text-xl">Initializing Camera...</p>
                    </div>
                </div>
            )}

            <video
                ref={videoRef}
                onLoadedMetadata={handleVideoMetadata}
                autoPlay
                playsInline
                muted
                className="absolute top-0 left-0 h-full w-full object-cover z-0"
            />
            {stream && videoDimensions.width > 0 && <WaterEffectCanvas videoRef={videoRef} videoDimensions={videoDimensions} />}
        </main>
    );
};

export default App;