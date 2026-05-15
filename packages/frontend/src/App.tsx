import { BrowserRouter, Routes, Route } from 'react-router-dom';
import JobFormPage from './pages/JobFormPage';
import JobDetailPage from './pages/JobDetailPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<JobFormPage />} />
        <Route path="/jobs/:hash" element={<JobDetailPage />} />
      </Routes>
    </BrowserRouter>
  );
}
