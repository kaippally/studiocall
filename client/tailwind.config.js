/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'progress-slide': 'progressSlide 1s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        progressSlide: { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(400%)' } },
      },
    },
  },
  plugins: [],
};
