import { createApp } from 'vue';

import App from './App.vue';
import './features/skills.js';
import { router } from './router.js';
import './styles.css';

createApp(App).use(router).mount('#app');
