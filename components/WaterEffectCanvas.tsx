import React, { useRef, useEffect, RefObject } from 'react';

interface WaterEffectCanvasProps {
    videoRef: RefObject<HTMLVideoElement>;
    videoDimensions: { width: number, height: number };
}

const VERTEX_SHADER_SOURCE = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_uv = a_position * 0.5 + 0.5;
    }
`;

const RENDER_FRAGMENT_SHADER_SOURCE = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform sampler2D u_water_map;
    uniform float u_ripple_strength;
    uniform vec2 u_resolution;
    uniform vec2 u_video_resolution;
    varying vec2 v_uv;

    void main() {
        // --- Aspect Ratio Correction ('object-cover') ---
        float canvas_aspect = u_resolution.x / u_resolution.y;
        float video_aspect = u_video_resolution.x / u_video_resolution.y;
        
        vec2 scale = vec2(1.0, 1.0);
        if (canvas_aspect > video_aspect) {
            scale.x = canvas_aspect / video_aspect;
        } else {
            scale.y = video_aspect / canvas_aspect;
        }
        
        vec2 video_uv = (v_uv - 0.5) * scale + 0.5;
        
        // --- Correct Video Orientation ---
        video_uv.y = 1.0 - video_uv.y; // Fix vertical flip from texture coordinates
        video_uv.x = 1.0 - video_uv.x; // Add lateral flip (mirror effect)

        // --- Water Ripple Calculation ---
        vec2 delta = vec2(1.0 / 512.0, 1.0 / 512.0);
        float h_l = texture2D(u_water_map, v_uv - vec2(delta.x, 0.0)).r;
        float h_r = texture2D(u_water_map, v_uv + vec2(delta.x, 0.0)).r;
        float h_d = texture2D(u_water_map, v_uv - vec2(0.0, delta.y)).r;
        float h_u = texture2D(u_water_map, v_uv + vec2(0.0, delta.y)).r;

        vec2 displacement = vec2(h_r - h_l, h_u - h_d);
        displacement.y = -displacement.y;
        
        // --- Final Color Calculation with Artifact Prevention ---
        // For pixels outside the original video frame (due to aspect ratio cropping),
        // we just want to sample the clamped edge color to avoid artifacts.
        // We don't apply ripples here because there's no valid texture information
        // for the ripple to distort from beyond the edge.
        if (video_uv.x < 0.0 || video_uv.x > 1.0 || video_uv.y < 0.0 || video_uv.y > 1.0) {
            gl_FragColor = texture2D(u_texture, clamp(video_uv, 0.0, 1.0));
        } else {
            // For pixels within the video frame, calculate the displaced coordinate
            // for the ripple effect and clamp it to ensure it still samples valid colors.
            vec2 displaced_tex_coord = video_uv + displacement * u_ripple_strength;
            gl_FragColor = texture2D(u_texture, clamp(displaced_tex_coord, 0.0, 1.0));
        }
    }
`;

const UPDATE_FRAGMENT_SHADER_SOURCE = `
    precision mediump float;
    uniform sampler2D u_water_map;
    uniform vec2 u_delta;
    uniform float u_damping;
    varying vec2 v_uv;

    void main() {
        vec4 info = texture2D(u_water_map, v_uv);
        
        vec2 x_delta = vec2(u_delta.x, 0.0);
        vec2 y_delta = vec2(0.0, u_delta.y);
        
        float n = texture2D(u_water_map, v_uv - y_delta).r;
        float s = texture2D(u_water_map, v_uv + y_delta).r;
        float w = texture2D(u_water_map, v_uv - x_delta).r;
        float e = texture2D(u_water_map, v_uv + x_delta).r;
        
        float new_height = (n + s + w + e) * 0.5 - info.g;
        
        new_height *= u_damping;
        
        gl_FragColor = vec4(new_height, info.r, 0.0, 1.0);
    }
`;

const DROP_FRAGMENT_SHADER_SOURCE = `
    precision mediump float;
    uniform sampler2D u_water_map;
    uniform vec2 u_center;
    uniform float u_radius;
    uniform float u_strength;
    uniform float u_aspect;
    varying vec2 v_uv;

    void main() {
        // Adjust coordinate system to be uniform (square) before calculating distance
        vec2 adjusted_uv = v_uv - u_center;
        adjusted_uv.x *= u_aspect;
        float dist = length(adjusted_uv);

        if (dist < u_radius) {
            float drop_factor = 1.0 - (dist / u_radius);
            float drop = (cos(drop_factor * 3.14159) * 0.5 + 0.5);
            gl_FragColor = texture2D(u_water_map, v_uv) + vec4(drop * u_strength, 0.0, 0.0, 0.0);
        } else {
            gl_FragColor = texture2D(u_water_map, v_uv);
        }
    }
`;

const WaterEffectCanvas: React.FC<WaterEffectCanvasProps> = ({ videoRef, videoDimensions }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas || !video || videoDimensions.width === 0) return;

        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: false, antialias: false });
        if (!gl) {
            console.error("WebGL not supported");
            return;
        }

        const TEXTURE_WIDTH = 512;
        const TEXTURE_HEIGHT = 512;
        const DAMPING = 0.985;
        const RIPPLE_STRENGTH = 0.1;

        let animationFrameId: number;
        let lastMousePos = { x: 0, y: 0 };
        let mouseMoved = false;

        const createShader = (type: number, source: string) => {
            const shader = gl.createShader(type);
            if (!shader) return null;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        };

        const createProgram = (vertexShader: WebGLShader, fragmentShader: WebGLShader) => {
            const program = gl.createProgram();
            if (!program) return null;
            gl.attachShader(program, vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(program));
                return null;
            }
            return program;
        };

        const createTexture = (width: number, height: number, data: ArrayBufferView | null = null) => {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            return texture;
        };
        
        const vertexShader = createShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)!;
        const renderProgram = createProgram(vertexShader, createShader(gl.FRAGMENT_SHADER, RENDER_FRAGMENT_SHADER_SOURCE)!)!;
        const updateProgram = createProgram(vertexShader, createShader(gl.FRAGMENT_SHADER, UPDATE_FRAGMENT_SHADER_SOURCE)!)!;
        const dropProgram = createProgram(vertexShader, createShader(gl.FRAGMENT_SHADER, DROP_FRAGMENT_SHADER_SOURCE)!)!;

        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        const videoTexture = createTexture(1, 1);
        let textureA = createTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT);
        let textureB = createTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT);

        const fboA = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textureA, 0);

        const fboB = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textureB, 0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        let currentFBO = fboA;
        let currentTexture = textureA;
        let nextFBO = fboB;
        let nextTexture = textureB;

        const useProgram = (program: WebGLProgram) => {
            gl.useProgram(program);
            const positionLocation = gl.getAttribLocation(program, 'a_position');
            gl.enableVertexAttribArray(positionLocation);
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
            const varyingLocation = gl.getAttribLocation(program, 'v_uv');
            if (varyingLocation >= 0) {
                 gl.vertexAttribPointer(varyingLocation, 2, gl.FLOAT, false, 0, 0);
                 gl.enableVertexAttribArray(varyingLocation);
            }
        };

        const drawQuad = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        const addDrop = (x: number, y: number, radius: number, strength: number) => {
            useProgram(dropProgram);
            gl.uniform2f(gl.getUniformLocation(dropProgram, 'u_center'), x, y);
            gl.uniform1f(gl.getUniformLocation(dropProgram, 'u_radius'), radius);
            gl.uniform1f(gl.getUniformLocation(dropProgram, 'u_strength'), strength);
            gl.uniform1f(gl.getUniformLocation(dropProgram, 'u_aspect'), gl.canvas.width / gl.canvas.height);

            gl.bindFramebuffer(gl.FRAMEBUFFER, nextFBO);
            gl.viewport(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, currentTexture);
            gl.uniform1i(gl.getUniformLocation(dropProgram, 'u_water_map'), 0);
            
            drawQuad();
            swapTextures();
        };

        const updateWaterMap = () => {
            useProgram(updateProgram);
            gl.uniform2f(gl.getUniformLocation(updateProgram, 'u_delta'), 1 / TEXTURE_WIDTH, 1 / TEXTURE_HEIGHT);
            gl.uniform1f(gl.getUniformLocation(updateProgram, 'u_damping'), DAMPING);

            gl.bindFramebuffer(gl.FRAMEBUFFER, nextFBO);
            gl.viewport(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
            
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, currentTexture);
            gl.uniform1i(gl.getUniformLocation(updateProgram, 'u_water_map'), 0);

            drawQuad();
            swapTextures();
        };

        const render = () => {
            useProgram(renderProgram);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            if(video.readyState >= video.HAVE_CURRENT_DATA) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            }
            gl.uniform1i(gl.getUniformLocation(renderProgram, 'u_texture'), 0);
            
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, currentTexture);
            gl.uniform1i(gl.getUniformLocation(renderProgram, 'u_water_map'), 1);
            
            gl.uniform1f(gl.getUniformLocation(renderProgram, 'u_ripple_strength'), RIPPLE_STRENGTH);
            gl.uniform2f(gl.getUniformLocation(renderProgram, 'u_resolution'), gl.canvas.width, gl.canvas.height);
            gl.uniform2f(gl.getUniformLocation(renderProgram, 'u_video_resolution'), videoDimensions.width, videoDimensions.height);


            drawQuad();
        };
        
        const swapTextures = () => {
            [currentFBO, nextFBO] = [nextFBO, currentFBO];
            [currentTexture, nextTexture] = [nextTexture, currentTexture];
        };

        const resize = () => {
            const { innerWidth, innerHeight } = window;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = innerWidth * dpr;
            canvas.height = innerHeight * dpr;
            canvas.style.width = `${innerWidth}px`;
            canvas.style.height = `${innerHeight}px`;
        };
        resize();

        const onMouseMove = (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = 1.0 - ((e.clientY - rect.top) / rect.height); // Invert Y to match WebGL coords
            lastMousePos = { x, y };
            mouseMoved = true;
        };

        const onMouseDown = (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = 1.0 - ((e.clientY - rect.top) / rect.height); // Invert Y to match WebGL coords
            addDrop(x, y, 0.05, 1.0);
        };
        
        const loop = () => {
            if (mouseMoved) {
                addDrop(lastMousePos.x, lastMousePos.y, 0.04, 0.1);
                mouseMoved = false;
            }
            updateWaterMap();
            render();
            animationFrameId = requestAnimationFrame(loop);
        };
        
        window.addEventListener('resize', resize);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mousedown', onMouseDown);

        loop();

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', resize);
            canvas.removeEventListener('mousemove', onMouseMove);
            canvas.removeEventListener('mousedown', onMouseDown);
            gl.deleteProgram(renderProgram);
            gl.deleteProgram(updateProgram);
            gl.deleteProgram(dropProgram);
            gl.deleteShader(vertexShader);
            gl.deleteBuffer(positionBuffer);
            gl.deleteTexture(videoTexture);
            gl.deleteTexture(textureA);
            gl.deleteTexture(textureB);
            gl.deleteFramebuffer(fboA);
            gl.deleteFramebuffer(fboB);
        };
    }, [videoRef, videoDimensions]);

    return <canvas ref={canvasRef} className="absolute top-0 left-0 h-full w-full z-10" />;
};

export default WaterEffectCanvas;
