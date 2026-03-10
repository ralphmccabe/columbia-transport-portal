-- 1. Setup Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create Tables
CREATE TABLE IF NOT EXISTS public.drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID REFERENCES public.drivers(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    status TEXT DEFAULT 'IN_PROGRESS',
    invoice_number TEXT,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS public.loads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id TEXT, -- session ID from tablet (changed from UUID for compatibility)
    invoice_number TEXT,
    billed_to TEXT,
    billed_addr TEXT,
    origin TEXT,
    destination TEXT,
    total_amount DECIMAL(10,2),
    items TEXT,
    truck_number TEXT,
    trailer_number TEXT,
    delivery_date TEXT,
    billing_terms TEXT,
    notes TEXT,
    pdf_url TEXT, -- Link to storage bucket
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    load_id UUID REFERENCES public.loads(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL, -- Path in storage bucket
    file_name TEXT NOT NULL,
    type TEXT NOT NULL, -- image/pdf/text
    label TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.gps_pings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id TEXT, -- session ID from tablet
    driver_name TEXT,
    truck_number TEXT,
    lat DECIMAL(10, 8),
    lng DECIMAL(11, 8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Set up Storage Buckets
-- (Manual step in Supabase Dashboard): 
-- Create a public bucket named 'load-packets'

-- 4. Reload Schema Cache (Fixes "Table not found" errors)
NOTIFY pgrst, 'reload schema';
