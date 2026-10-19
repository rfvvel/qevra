import { AuthProvider } from './app/auth-context';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(<StrictMode><AuthProvider><RouterProvider router={router} /></AuthProvider></StrictMode>);
