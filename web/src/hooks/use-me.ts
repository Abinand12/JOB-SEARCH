import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Me } from "@/lib/types";

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
